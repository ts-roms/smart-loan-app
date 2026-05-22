import type {
  CustomerLedger,
  CustomerLedgerRepository,
  CustomerRepository,
  NotificationRepository,
  PrismaClient,
} from "@loan/db";
import { renderCustomerStatement } from "@loan/pdf";

import { getBranding } from "../../lib/branding.js";
import type { LedgerScope } from "./schemas.js";

/**
 * Statement-ready notification result. Same shape for both the
 * "customer has email on file" and "no email — in-app only" cases so
 * the controller doesn't branch on the wire.
 */
export interface StatementEmailResult {
  ok: true;
  sentTo: string | null;
  message: string;
}

/**
 * CustomerLedgerService — aggregates the unified statement of account
 * (loans + cooperative activity), renders it as PDF, and dispatches
 * the "your statement is ready" notification.
 *
 * Why these three sit together: they all operate on the same ledger
 * artefact for the same customer. Splitting them into separate
 * services would force each consumer to reassemble the build options.
 */
export class CustomerLedgerService {
  constructor(
    private readonly customers: CustomerRepository,
    private readonly ledgerRepo: CustomerLedgerRepository,
    private readonly notifications: NotificationRepository,
    private readonly prisma: PrismaClient,
  ) {}

  /**
   * Build the unified ledger snapshot for a customer. Returns null
   * when the customer can't be resolved so the controller can map to
   * 404 without us coupling to FastifyReply here.
   */
  async build(
    idOrNumber: string,
    opts: { from?: Date | null; to?: Date | null; scope: LedgerScope },
  ): Promise<{ customerNumber: string; ledger: CustomerLedger } | null> {
    const existing = await this.customers.findByIdOrNumber(idOrNumber);
    if (!existing) return null;
    const ledger = await this.ledgerRepo.build(existing.id, {
      from: opts.from ?? undefined,
      to: opts.to ?? undefined,
      scope: opts.scope,
    });
    return { customerNumber: existing.number, ledger };
  }

  /**
   * Render the ledger to a PDF buffer. Branding is pulled per-request
   * so a recently-updated company name / logo shows up immediately
   * without needing a deploy.
   */
  async renderPdf(ledger: CustomerLedger): Promise<Buffer> {
    const branding = await getBranding(this.prisma);
    return renderCustomerStatement({
      companyName: branding.companyName,
      asOf: new Date(ledger.asOf),
      range: {
        from: ledger.range.from ? new Date(ledger.range.from) : null,
        to: ledger.range.to ? new Date(ledger.range.to) : null,
      },
      scope: ledger.scope,
      customer: ledger.customer,
      summary: ledger.summary,
      entries: ledger.entries.map((e) => ({ ...e, date: new Date(e.date) })),
    });
  }

  /**
   * Dispatch a "statement ready" notification — IN_APP always, EMAIL
   * only when the customer has one on file. Deliberately does NOT
   * attach the PDF: financial data over plain email is a privacy
   * hazard, and authorised recipients can fetch it themselves via the
   * portal.
   *
   * Idempotent enough for repeated clicks; each call dispatches a
   * fresh notification.
   */
  async dispatchStatementReady(
    idOrNumber: string,
  ): Promise<StatementEmailResult | null> {
    const existing = await this.customers.findByIdOrNumber(idOrNumber);
    if (!existing) return null;

    const customerName = [
      existing.firstName,
      existing.middleName,
      existing.lastName,
    ]
      .filter(Boolean)
      .join(" ");
    const asOf = new Date().toISOString().slice(0, 10);
    const data = { customerName, asOf };

    await this.notifications.dispatch({
      event: "STATEMENT_READY",
      channel: "IN_APP",
      recipient: existing.email ?? existing.phone,
      data,
      refType: "Customer",
      refId: existing.id,
      customerId: existing.id,
    });

    if (existing.email) {
      await this.notifications.dispatch({
        event: "STATEMENT_READY",
        channel: "EMAIL",
        recipient: existing.email,
        data,
        refType: "Customer",
        refId: existing.id,
        customerId: existing.id,
      });
    }

    return {
      ok: true,
      sentTo: existing.email ?? null,
      message: existing.email
        ? `Notification dispatched to ${existing.email}.`
        : "Customer has no email on file — in-app notification logged.",
    };
  }
}
