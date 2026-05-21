/**
 * Self-serve borrower portal routes.
 *
 * Auth: requires a logged-in CUSTOMER. Every action is implicitly scoped
 * to the `Customer` row linked to `User.customerId`. No path needs the
 * customer id — we resolve it from the JWT.
 */

import {
  CooperativeRepository,
  CreditScoreRepository,
  CustomerLedgerRepository,
  KycRepository,
  LoanRepository,
  PaymentIntentRepository,
  type PrismaClient,
} from "@loan/db";
import { validateKyc } from "@loan/kyc";
import { MockProvider } from "@loan/payments";
import { renderCustomerStatement } from "@loan/pdf";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { getBranding } from "../lib/branding.js";

const applySchema = z.object({
  productCode: z.string().min(1).max(40),
  principal: z.number().positive().max(50_000_000),
  termMonths: z.number().int().positive().max(360),
  annualInterestRate: z.number().min(0).max(1),
  purpose: z.string().max(200).optional(),
  vehicle: z
    .object({
      kind: z.enum(["CAR", "MOTORCYCLE"]),
      make: z.string().min(1).max(80),
      model: z.string().min(1).max(80),
      year: z.number().int().min(1900).max(2100),
      plateNumber: z.string().max(40).optional(),
      chassisNumber: z.string().max(80).optional(),
      engineNumber: z.string().max(80).optional(),
      color: z.string().max(40).optional(),
      appraisedValue: z.number().positive(),
      notes: z.string().max(500).optional(),
    })
    .optional(),
  property: z
    .object({
      propertyType: z.string().min(1).max(80),
      address: z.string().min(1).max(500),
      city: z.string().min(1).max(80),
      province: z.string().max(80).optional(),
      postalCode: z.string().max(20).optional(),
      titleNumber: z.string().max(80).optional(),
      taxDecNumber: z.string().max(80).optional(),
      areaSqm: z.number().positive().optional(),
      appraisedValue: z.number().positive(),
      notes: z.string().max(500).optional(),
    })
    .optional(),
  applicationSelfieUrl: z.string().max(500).optional(),
});

const kycSubmitSchema = z.object({
  documentType: z.enum([
    "ID_FRONT",
    "ID_BACK",
    "PROOF_OF_INCOME",
    "PROOF_OF_ADDRESS",
    "SELFIE",
    "VEHICLE_OR",
    "VEHICLE_CR",
    "PROPERTY_TITLE",
    "TAX_DECLARATION",
  ]),
  documentUrl: z.string().min(1),
  notes: z.string().max(500).optional(),
});

const intentSchema = z.object({
  loanId: z.string().uuid(),
  amount: z.number().positive(),
});

async function resolveCustomerId(
  req: FastifyRequest,
  reply: FastifyReply,
  prisma: PrismaClient,
): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { id: req.user.sub },
    select: { role: true, customerId: true },
  });
  if (!user || user.role !== "CUSTOMER" || !user.customerId) {
    reply.code(403).send({
      error: "Forbidden",
      message: "Portal requires a CUSTOMER account linked to a customer row.",
    });
    return null;
  }
  return user.customerId;
}

export async function portalRoutes(app: FastifyInstance) {
  const loans = new LoanRepository(app.prisma);
  const scores = new CreditScoreRepository(app.prisma);
  const kyc = new KycRepository(app.prisma);
  const coop = new CooperativeRepository(app.prisma);
  const ledger = new CustomerLedgerRepository(app.prisma);
  const baseUrl =
    process.env.PUBLIC_API_URL ??
    `http://localhost:${process.env.PORT ?? 3001}`;
  const provider = new MockProvider({ baseUrl });
  const intents = new PaymentIntentRepository(app.prisma, provider);

  app.addHook("preHandler", app.authenticate);

  /** Current borrower's profile, linked customer row, and a summary. */
  app.get("/me", async (req, reply) => {
    const customerId = await resolveCustomerId(req, reply, app.prisma);
    if (!customerId) return;
    const customer = await app.prisma.customer.findUnique({
      where: { id: customerId },
    });
    if (!customer) {
      return reply
        .code(404)
        .send({ error: "NotFound", message: "Customer record missing." });
    }
    const score = await scores.latestForCustomer(customerId);
    return {
      customer,
      score: score
        ? { score: score.score, tier: score.tier, computedAt: score.computedAt }
        : null,
    };
  });

  /** All loans owned by the calling customer. */
  app.get("/loans", async (req, reply) => {
    const customerId = await resolveCustomerId(req, reply, app.prisma);
    if (!customerId) return;
    return app.prisma.loanApplication.findMany({
      where: { customerId },
      orderBy: { submittedAt: "desc" },
    });
  });

  app.get<{ Params: { id: string } }>("/loans/:id", async (req, reply) => {
    const customerId = await resolveCustomerId(req, reply, app.prisma);
    if (!customerId) return;
    const loan = await loans.findByIdOrNumber(req.params.id);
    if (!loan || loan.customerId !== customerId) {
      return reply.code(404).send({ error: "NotFound" });
    }
    return loan;
  });

  /**
   * Borrower self-signs. Same shape as the officer-mediated path; captures
   * IP from the request so the audit trail records *where* the customer
   * was when they signed.
   */
  app.post<{ Params: { id: string }; Body: { signatureUrl: string } }>(
    "/loans/:id/sign-borrower",
    async (req, reply) => {
      const customerId = await resolveCustomerId(req, reply, app.prisma);
      if (!customerId) return;
      const loan = await app.prisma.loanApplication.findUnique({
        where: { id: req.params.id },
        select: { customerId: true },
      });
      if (!loan || loan.customerId !== customerId) {
        return reply.code(404).send({ error: "NotFound" });
      }
      const url = req.body?.signatureUrl;
      if (!url || typeof url !== "string" || url.length === 0) {
        return reply
          .code(400)
          .send({ error: "BadRequest", message: "signatureUrl required" });
      }
      const ip =
        (req.headers["x-forwarded-for"] as string | undefined)
          ?.split(",")[0]
          ?.trim() ?? req.ip;
      return app.prisma.loanApplication.update({
        where: { id: req.params.id },
        data: {
          borrowerSignatureUrl: url,
          borrowerSignedAt: new Date(),
          borrowerSignedFromIp: ip,
        },
      });
    },
  );

  app.post("/loans/apply", async (req, reply) => {
    const customerId = await resolveCustomerId(req, reply, app.prisma);
    if (!customerId) return;
    const parsed = applySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const score = await scores.latestForCustomer(customerId);
    try {
      const created = await loans.apply({
        ...parsed.data,
        customerId,
        submittedById: req.user.sub,
        creditScoreAtApply: score?.score ?? null,
        tierAtApply: score?.tier ?? null,
      });
      return reply.code(201).send(created);
    } catch (err) {
      return reply.code(400).send({
        error: "BadRequest",
        message: (err as Error).message,
        issues: (err as Error & { issues?: unknown }).issues,
      });
    }
  });

  // ─── KYC ───────────────────────────────────────────────────────────

  app.get("/kyc", async (req, reply) => {
    const customerId = await resolveCustomerId(req, reply, app.prisma);
    if (!customerId) return;
    const docs = await kyc.listForCustomer(customerId);
    return { docs, status: validateKyc(docs) };
  });

  app.post("/kyc", async (req, reply) => {
    const customerId = await resolveCustomerId(req, reply, app.prisma);
    if (!customerId) return;
    const parsed = kycSubmitSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    return reply.code(201).send(
      await kyc.submit({
        customerId,
        documentType: parsed.data.documentType,
        documentUrl: parsed.data.documentUrl,
        notes: parsed.data.notes,
        submittedById: req.user.sub,
      }),
    );
  });

  // ─── Payments ──────────────────────────────────────────────────────

  /**
   * Create a payment intent for one of MY loans. Validates ownership before
   * delegating to the generic PaymentIntentRepository.
   */
  app.post("/payments/intents", async (req, reply) => {
    const customerId = await resolveCustomerId(req, reply, app.prisma);
    if (!customerId) return;
    const parsed = intentSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const loan = await app.prisma.loanApplication.findUnique({
      where: { id: parsed.data.loanId },
      select: { customerId: true },
    });
    if (!loan || loan.customerId !== customerId) {
      return reply.code(404).send({ error: "NotFound" });
    }
    const intent = await intents.create({
      loanId: parsed.data.loanId,
      amount: parsed.data.amount,
      idempotencyKey: randomUUID(),
      webhookUrl: `${baseUrl}/api/v1/payments/webhook/${provider.name.toLowerCase()}`,
      createdById: req.user.sub,
    });
    return reply.code(201).send(intent);
  });

  app.get<{ Params: { id: string } }>(
    "/payments/intents/:id",
    async (req, reply) => {
      const customerId = await resolveCustomerId(req, reply, app.prisma);
      if (!customerId) return;
      const intent = await intents.findByIdOrNumber(req.params.id);
      if (!intent) return reply.code(404).send({ error: "NotFound" });
      const loan = await app.prisma.loanApplication.findUnique({
        where: { id: intent.loanId },
        select: { customerId: true },
      });
      if (loan?.customerId !== customerId) {
        return reply.code(404).send({ error: "NotFound" });
      }
      return intent;
    },
  );

  // ─── Cooperative member views (read-only) ─────────────────────────
  //
  // Member can see their own contributions / savings / lifetime totals.
  // Every query is implicitly scoped to the JWT subject's customer id
  // — there's no path parameter, no body field that influences the
  // filter, no way to ask "give me someone else's data".

  /** Lifetime rollup + recent activity. Powers the dashboard widget. */
  app.get("/member-ledger", async (req, reply) => {
    const customerId = await resolveCustomerId(req, reply, app.prisma);
    if (!customerId) return;
    const result = await coop.memberLedger(customerId);
    if (!result) return reply.code(404).send({ error: "NotFound" });
    return result;
  });

  /**
   * Full statement of account for the logged-in borrower — loans + coop
   * activity combined. Mirror of the staff `/customers/:id/ledger`
   * endpoint, but scoped to the authenticated customer so a borrower
   * can only see their own ledger.
   */
  app.get<{
    Querystring: {
      from?: string;
      to?: string;
      scope?: string;
      format?: string;
    };
  }>("/me/ledger", async (req, reply) => {
    const customerId = await resolveCustomerId(req, reply, app.prisma);
    if (!customerId) return;
    const parsedScope = (req.query.scope ?? "ALL").toUpperCase();
    const scope =
      parsedScope === "LOANS" || parsedScope === "COOP" || parsedScope === "ALL"
        ? (parsedScope as "ALL" | "LOANS" | "COOP")
        : "ALL";
    const from = req.query.from ? new Date(req.query.from) : undefined;
    const to = req.query.to ? new Date(req.query.to) : undefined;
    const data = await ledger.build(customerId, { from, to, scope });
    if (req.query.format === "csv") {
      // Reuse the same CSV shape as the staff route. Inline because
      // sharing the helper across both files would require lifting it
      // into @loan/db, and the format is only a few lines.
      const esc = (s: string): string =>
        /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      const lines = [
        [
          "Date",
          "Kind",
          "Description",
          "Loan",
          "Direction",
          "Amount",
          "Balance",
          "Reference",
          "Notes",
        ]
          .map(esc)
          .join(","),
      ];
      for (const e of data.entries) {
        lines.push(
          [
            e.date,
            e.kind,
            e.description,
            e.loanNumber ?? "",
            e.direction,
            e.amount.toFixed(2),
            e.runningBalance.toFixed(2),
            e.ref ?? "",
            e.notes ?? "",
          ]
            .map(esc)
            .join(","),
        );
      }
      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header(
        "Content-Disposition",
        `attachment; filename="my-statement.csv"`,
      );
      return reply.send(lines.join("\r\n") + "\r\n");
    }
    return data;
  });

  /** Borrower-side PDF statement. Same payload as the staff route. */
  app.get<{
    Querystring: { from?: string; to?: string; scope?: string };
  }>("/me/ledger.pdf", async (req, reply) => {
    const customerId = await resolveCustomerId(req, reply, app.prisma);
    if (!customerId) return;
    const parsedScope = (req.query.scope ?? "ALL").toUpperCase();
    const scope =
      parsedScope === "LOANS" || parsedScope === "COOP" || parsedScope === "ALL"
        ? (parsedScope as "ALL" | "LOANS" | "COOP")
        : "ALL";
    const from = req.query.from ? new Date(req.query.from) : undefined;
    const to = req.query.to ? new Date(req.query.to) : undefined;
    const data = await ledger.build(customerId, { from, to, scope });
    const branding = await getBranding(app.prisma);
    const buf = await renderCustomerStatement({
      companyName: branding.companyName,
      asOf: new Date(data.asOf),
      range: {
        from: data.range.from ? new Date(data.range.from) : null,
        to: data.range.to ? new Date(data.range.to) : null,
      },
      scope: data.scope,
      customer: data.customer,
      summary: data.summary,
      entries: data.entries.map((e) => ({ ...e, date: new Date(e.date) })),
    });
    reply.header("Content-Type", "application/pdf");
    reply.header(
      "Content-Disposition",
      `attachment; filename="my-statement.pdf"`,
    );
    return reply.send(buf);
  });

  /** Full contribution history (newest first). Supports ?format=csv. */
  app.get<{ Querystring: { format?: string } }>(
    "/contributions",
    async (req, reply) => {
      const customerId = await resolveCustomerId(req, reply, app.prisma);
      if (!customerId) return;
      const rows = await app.prisma.contribution.findMany({
        where: { customerId },
        orderBy: { contributedAt: "desc" },
      });
      if (req.query.format === "csv") {
        const csv = toCsv(
          [
            "Date",
            "Capital Build-Up",
            "Mortuary Fund",
            "Emergency Fund",
            "Notes",
          ],
          rows.map((r) => [
            new Date(r.contributedAt).toISOString().slice(0, 10),
            r.capitalBuildUp.toString(),
            r.mortuaryFund.toString(),
            r.emergencyFund.toString(),
            r.notes ?? "",
          ]),
        );
        reply.header("Content-Type", "text/csv; charset=utf-8");
        reply.header(
          "Content-Disposition",
          `attachment; filename="contributions-${new Date().toISOString().slice(0, 10)}.csv"`,
        );
        return csv;
      }
      return rows;
    },
  );

  /** Full savings history (newest first). Supports ?format=csv. */
  app.get<{ Querystring: { format?: string } }>(
    "/savings",
    async (req, reply) => {
      const customerId = await resolveCustomerId(req, reply, app.prisma);
      if (!customerId) return;
      const rows = await app.prisma.savingsTransaction.findMany({
        where: { customerId },
        orderBy: { txnDate: "desc" },
      });
      if (req.query.format === "csv") {
        const csv = toCsv(
          ["Date", "Kind", "Amount", "Notes"],
          rows.map((r) => [
            new Date(r.txnDate).toISOString().slice(0, 10),
            r.kind,
            r.amount.toString(),
            r.notes ?? "",
          ]),
        );
        reply.header("Content-Type", "text/csv; charset=utf-8");
        reply.header(
          "Content-Disposition",
          `attachment; filename="savings-${new Date().toISOString().slice(0, 10)}.csv"`,
        );
        return csv;
      }
      return rows;
    },
  );

  // ─── Self-service profile edit ────────────────────────────────────
  //
  // Allowlist: phone, email, address, city, province, postalCode.
  // Names, date of birth, gov't ID, employment, income, KYC status —
  // none of these are editable here. They require either officer
  // re-verification or a separate "update my employment" workflow we
  // haven't built yet. Refusing the field is much safer than letting
  // a borrower silently rewrite their own KYC record.
  const profileUpdateSchema = z.object({
    phone: z.string().min(7).max(40).optional(),
    email: z.string().email().max(120).optional().nullable(),
    address: z.string().min(1).max(500).optional(),
    city: z.string().min(1).max(80).optional(),
    province: z.string().max(80).optional().nullable(),
    postalCode: z.string().max(20).optional().nullable(),
  });

  app.patch("/me", async (req, reply) => {
    const customerId = await resolveCustomerId(req, reply, app.prisma);
    if (!customerId) return;
    const parsed = profileUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const updated = await app.prisma.customer.update({
      where: { id: customerId },
      data: parsed.data,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phone: true,
        email: true,
        address: true,
        city: true,
        province: true,
        postalCode: true,
        kycStatus: true,
      },
    });
    return updated;
  });
}

/**
 * Minimal RFC-4180 CSV encoder. Quotes any cell that contains a comma,
 * quote, or newline, and doubles-up embedded quotes. Sufficient for
 * Excel / Google Sheets imports. We don't depend on a CSV lib here
 * because the payload is small and the format is fully under our control.
 */
function toCsv(header: string[], rows: string[][]): string {
  const esc = (cell: string): string => {
    if (/[",\n\r]/.test(cell)) {
      return `"${cell.replace(/"/g, '""')}"`;
    }
    return cell;
  };
  const lines = [header.map(esc).join(",")];
  for (const row of rows) lines.push(row.map(esc).join(","));
  return lines.join("\r\n") + "\r\n";
}
