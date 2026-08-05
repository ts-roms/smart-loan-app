import { phoneChangeError } from "@loan/shared-utils";

import type {
  Customer,
  CustomerListFilter,
  CustomerListItem,
  CustomerRepository,
  Page,
  PrismaClient,
  ScreeningRepository,
} from "@loan/db";

import type { CustomerPatchInput, CustomerWriteInput } from "./schemas";
import { toDateOrUndefined } from "./helpers";

/**
 * CustomerService — the application/business layer for customer CRUD +
 * derived rollups (summary, repeat-eligibility).
 *
 * Why this exists separate from CustomerRepository:
 *   - The repository (in libs/db) is pure storage. It knows about Prisma
 *     rows; it doesn't know about AML screening or aggregation across
 *     other tables.
 *   - The service composes the storage layer with cross-cutting
 *     concerns: AML screening kicks off on create; the summary endpoint
 *     joins customer + open loans + outstanding balance.
 *   - Routes / controllers stay thin and the same business operation
 *     can be reused (e.g. by a future CLI importer or a job).
 */
interface PhoneIssue {
  path: [string];
  message: string;
}

export type UpdateResult =
  | { ok: true; customer: Customer }
  | { ok: false; reason: "NotFound" }
  | { ok: false; reason: "Invalid"; issues: PhoneIssue[] };

/**
 * A phone complaint, or null when there's nothing to complain about —
 * the field wasn't sent, or it matches what's already on file.
 */
function phoneIssue(
  field: string,
  next: string | undefined,
  previous: string | null | undefined,
  optional = false,
): PhoneIssue | null {
  if (next === undefined) return null;
  const message = phoneChangeError(next, previous, { optional });
  return message ? { path: [field], message } : null;
}

export class CustomerService {
  constructor(
    private readonly customers: CustomerRepository,
    private readonly prisma: PrismaClient,
    private readonly screening: ScreeningRepository,
  ) {}

  /**
   * List rows carry a `hasLoans` marker — see {@link CustomerListItem}.
   * Search and filtering run in Postgres; see CustomerRepository.list for
   * why they can't run in the client.
   */
  list(filter: CustomerListFilter = {}): Promise<Page<CustomerListItem>> {
    return this.customers.list(filter);
  }

  findByIdOrNumber(idOrNumber: string): Promise<Customer | null> {
    return this.customers.findByIdOrNumber(idOrNumber);
  }

  /**
   * Create a customer record, then kick off a best-effort AML screen.
   * The screen runs against the mock watchlist by default and never
   * blocks the response — a scheduled job picks up PENDING customers
   * on the next tick if this fire-and-forget fails.
   *
   * Date fields arrive as ISO strings on the wire; we coerce to Date
   * here so the wire format stays JSON-friendly while Prisma's column
   * types remain strict.
   */
  async create(input: CustomerWriteInput): Promise<Customer> {
    const created = await this.customers.create({
      ...input,
      dateOfBirth: new Date(input.dateOfBirth),
      hireDate: toDateOrUndefined(input.hireDate),
      regularizationDate: toDateOrUndefined(input.regularizationDate),
      spouseDateOfBirth: toDateOrUndefined(input.spouseDateOfBirth),
    });
    void this.screening.screen(created.id).catch(() => undefined);
    return created;
  }

  /**
   * Patch a customer record by either UUID or human number. Returns
   * null when the lookup fails so the controller can map to 404
   * without us coupling to FastifyReply here.
   */
  async update(
    idOrNumber: string,
    input: CustomerPatchInput,
  ): Promise<UpdateResult> {
    const existing = await this.customers.findByIdOrNumber(idOrNumber);
    if (!existing) return { ok: false, reason: "NotFound" };

    // Phone numbers are validated on CHANGE, not on presence. The form
    // resubmits every field it rendered, so checking the value alone
    // would let one bad legacy number block every future edit of the
    // record — including the edit that fixes it.
    const issues = [
      phoneIssue("phone", input.phone, existing.phone),
      phoneIssue(
        "secondaryPhone",
        input.secondaryPhone,
        existing.secondaryPhone,
        true,
      ),
      phoneIssue(
        "spouseContact",
        input.spouseContact,
        existing.spouseContact,
        true,
      ),
    ].filter((i): i is PhoneIssue => i !== null);
    if (issues.length > 0) return { ok: false, reason: "Invalid", issues };

    const customer = await this.customers.update(existing.id, {
      ...input,
      dateOfBirth: toDateOrUndefined(input.dateOfBirth),
      hireDate: toDateOrUndefined(input.hireDate),
      regularizationDate: toDateOrUndefined(input.regularizationDate),
      spouseDateOfBirth: toDateOrUndefined(input.spouseDateOfBirth),
    });
    return { ok: true, customer };
  }

  /**
   * Customer rollup — base record + active-loans count + outstanding
   * principal across DISBURSED / ACTIVE / DEFAULTED. Cheaper than
   * fetching every loan separately for the side-drawer surface.
   */
  async summary(idOrNumber: string) {
    const customer = await this.customers.findByIdOrNumber(idOrNumber);
    if (!customer) return null;

    const loans = await this.prisma.loanApplication.findMany({
      where: {
        customerId: customer.id,
        status: { in: ["DISBURSED", "ACTIVE", "DEFAULTED"] },
      },
      include: {
        schedule: {
          where: { paidInFullAt: null },
          select: {
            totalDue: true,
            principalPaid: true,
            interestPaid: true,
          },
        },
      },
    });

    let outstanding = 0;
    for (const l of loans) {
      for (const s of l.schedule) {
        // An open installment can be partly settled on both legs — subtract
        // interest collected as well as principal, or partial payments show
        // up as if nothing had been paid.
        outstanding +=
          Number(s.totalDue) - Number(s.principalPaid) - Number(s.interestPaid);
      }
    }

    const totalLoansCount = await this.prisma.loanApplication.count({
      where: { customerId: customer.id },
    });

    return {
      customer,
      activeLoansCount: loans.length,
      totalLoansCount,
      outstanding: Math.round(outstanding * 100) / 100,
      activeLoans: loans.map((l) => ({
        id: l.id,
        number: l.number,
        productCode: l.productCode,
        principal: l.principal,
        status: l.status,
        disbursedAt: l.disbursedAt,
      })),
    };
  }

  /**
   * Repeat-loan eligibility. A customer is eligible when
   * they have at least one CLOSED loan and no DEFAULTED / WRITTEN_OFF in
   * history. We return the full rollup so the application form can show
   * a "Repeat borrower" badge and pre-populate KYC re-use hints.
   */
  async repeatEligibility(idOrNumber: string) {
    const customer = await this.customers.findByIdOrNumber(idOrNumber);
    if (!customer) return null;

    const loans = await this.prisma.loanApplication.findMany({
      where: { customerId: customer.id },
      select: { id: true, status: true, closedAt: true, isRepeat: true },
      orderBy: { submittedAt: "desc" },
    });

    const closedCount = loans.filter((l) => l.status === "CLOSED").length;
    const writtenOff = loans.filter((l) => l.status === "WRITTEN_OFF").length;
    const defaulted = loans.filter((l) => l.status === "DEFAULTED").length;
    const lastClosedAt =
      loans.find((l) => l.status === "CLOSED")?.closedAt ?? null;

    // Policy: "completed repayment of the previous loan (or be in good standing)"
    const eligible = closedCount > 0 && writtenOff === 0 && defaulted === 0;

    return {
      customerId: customer.id,
      eligible,
      closedLoansCount: closedCount,
      defaultedLoansCount: defaulted,
      writtenOffLoansCount: writtenOff,
      lastClosedAt,
      /// KYC verified docs that the next application may waive re-submission of.
      kycVerified: customer.kycStatus === "VERIFIED",
    };
  }
}
