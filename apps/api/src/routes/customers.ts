import { CustomerLedgerRepository, CustomerRepository } from "@loan/db";
import type { CustomerLedger } from "@loan/db";
import { renderCustomerStatement } from "@loan/pdf";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { getBranding } from "../lib/branding.js";

/**
 * Customer registration schema — expanded for PH-standard borrower
 * onboarding (FRD §1.4). Includes conditional cross-field validation
 * driven by `.superRefine`:
 *
 *   • civilStatus === MARRIED   → spouseName is required
 *   • employmentStatus is one of EMPLOYED/SELF_EMPLOYED/FREELANCE
 *                                 → employerName + position required
 *
 * Most fields default to optional so partial saves still pass. The
 * client UI marks the required ones explicitly so the user knows
 * what's mandatory before submit.
 *
 * The base object schema is exported separately because `.partial()`
 * doesn't exist on ZodEffects (the result of `.superRefine`). PATCH
 * uses the base partial; POST uses the refined full schema.
 */
const customerBaseSchema = z.object({
  // Personal
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  middleName: z.string().max(80).optional(),
  suffix: z.string().max(20).optional(),
  dateOfBirth: z.string(),
  gender: z
    .enum(["MALE", "FEMALE", "NON_BINARY", "PREFER_NOT_TO_SAY"])
    .optional(),
  sex: z.enum(["MALE", "FEMALE", "INTERSEX"]).optional(),
  civilStatus: z
    .enum(["SINGLE", "MARRIED", "WIDOWED", "SEPARATED", "ANNULLED", "DIVORCED"])
    .optional(),

  // Contact
  phone: z.string().min(7).max(40),
  secondaryPhone: z.string().max(40).optional(),
  email: z.string().email().optional(),

  // Address (PSGC-style)
  address: z.string().max(500),
  addressLine2: z.string().max(500).optional(),
  barangay: z.string().max(120).optional(),
  city: z.string().max(80),
  province: z.string().max(80).optional(),
  region: z.string().max(80).optional(),
  postalCode: z.string().max(20).optional(),

  // Spouse (validated below)
  spouseName: z.string().max(160).optional(),
  spouseDateOfBirth: z.string().optional(),
  spouseContact: z.string().max(40).optional(),
  spouseOccupation: z.string().max(120).optional(),

  // Government ID
  governmentIdType: z.enum([
    "PASSPORT",
    "DRIVERS_LICENSE",
    "NATIONAL_ID",
    "SSS",
    "TIN",
    "OTHER",
  ]),
  governmentIdNumber: z.string().max(60),

  // Employment
  employmentStatus: z.enum([
    "EMPLOYED",
    "SELF_EMPLOYED",
    "FREELANCE",
    "UNEMPLOYED",
    "RETIRED",
    "STUDENT",
  ]),
  employerName: z.string().max(200).optional(),
  jobTitle: z.string().max(120).optional(),
  position: z.string().max(120).optional(),
  hireDate: z.string().optional(),
  regularizationDate: z.string().optional(),
  monthlyIncome: z.number().nonnegative(),
  yearsAtCurrentJob: z.number().nonnegative().optional(),
});

/**
 * Cross-field validation applied on full POST payloads. PATCH paths
 * skip this because partial updates can legitimately set just one
 * field — re-checking the conditional rule there would force the UI
 * to resend unchanged spouse fields on every status edit.
 */
const customerSchema = customerBaseSchema.superRefine((data, ctx) => {
  if (data.civilStatus === "MARRIED" && !data.spouseName?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["spouseName"],
      message: "Spouse name is required when civil status is MARRIED.",
    });
  }
  const needsEmployer =
    data.employmentStatus === "EMPLOYED" ||
    data.employmentStatus === "SELF_EMPLOYED" ||
    data.employmentStatus === "FREELANCE";
  if (needsEmployer && !data.employerName?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["employerName"],
      message:
        "Company / employer name is required for this employment status.",
    });
  }
});

/**
 * Bulk import wire schema — a thin envelope around an array of customer
 * rows. We deliberately use `passthrough` per row so the per-row zod
 * refinement inside the handler can give a precise field-level error;
 * if we refined here, all rows would be lumped into one validation
 * failure and the operator couldn't tell which line was bad.
 */
const bulkImportSchema = z.object({
  rows: z.array(z.record(z.unknown())).min(1).max(500),
  stopOnError: z.boolean().optional().default(false),
  dryRun: z.boolean().optional().default(false),
});

export async function customerRoutes(app: FastifyInstance) {
  const customers = new CustomerRepository(app.prisma);
  const ledgerRepo = new CustomerLedgerRepository(app.prisma);

  app.addHook("preHandler", app.authenticate);

  app.get("/", async () => customers.list());

  // GET /customers/:idOrNumber — accepts either the UUID or the human
  // "CUST-2026-..." reference number. The frontend now navigates via the
  // number; UUIDs are still resolved for back-compat with old links.
  app.get<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const c = await customers.findByIdOrNumber(req.params.id);
    if (!c) return reply.code(404).send({ error: "NotFound" });
    return c;
  });

  app.post("/", async (req, reply) => {
    const parsed = customerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    // Coerce any date-shaped strings to Date so Prisma's DateTime
    // columns accept them. Doing this here (not in the schema) keeps
    // the wire format JSON-friendly while the storage type stays strict.
    const created = await customers.create({
      ...parsed.data,
      dateOfBirth: new Date(parsed.data.dateOfBirth),
      hireDate: parsed.data.hireDate
        ? new Date(parsed.data.hireDate)
        : undefined,
      regularizationDate: parsed.data.regularizationDate
        ? new Date(parsed.data.regularizationDate)
        : undefined,
      spouseDateOfBirth: parsed.data.spouseDateOfBirth
        ? new Date(parsed.data.spouseDateOfBirth)
        : undefined,
    });
    // Best-effort AML screen — runs against the mock watchlist by default.
    // Errors are non-fatal; a scheduled job picks up PENDING customers
    // on the next tick.
    void app.screening.screen(created.id).catch(() => undefined);
    return reply.code(201).send(created);
  });

  /**
   * Bulk customer import. Accepts up to 500 rows in one shot. Each row
   * passes through the same refined zod schema as POST /customers, then
   * goes through `bulkCreate` (which calls `create` per row, generating
   * fresh CUST-... numbers and posting AML screening best-effort).
   *
   * The endpoint always returns 207 (Multi-Status) so a partial success
   * is observable client-side — `results[i].ok` is the per-row verdict.
   * Pass `stopOnError:true` to short-circuit after the first failure.
   *
   * Also supports `dryRun:true` — validation runs but no rows are
   * created. Useful for preview before commit.
   */
  app.post(
    "/bulk",
    { preHandler: app.requirePermission("customers.write") },
    async (req, reply) => {
      const parsed = bulkImportSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "ValidationError", issues: parsed.error.issues });
      }
      const { rows, stopOnError, dryRun } = parsed.data;

      // First pass — refined zod validation per row. Bad rows never
      // touch the DB; their error message is returned alongside the
      // good rows so the operator can fix the CSV and re-submit.
      const validated: Array<
        | { ok: true; index: number; data: z.infer<typeof customerSchema> }
        | { ok: false; index: number; error: string }
      > = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const r = customerSchema.safeParse(row);
        if (r.success) {
          validated.push({ ok: true, index: i, data: r.data });
        } else {
          const first = r.error.issues[0];
          const msg = first
            ? `${first.path.join(".") || "row"}: ${first.message}`
            : "Validation failed";
          validated.push({ ok: false, index: i, error: msg });
          if (stopOnError) break;
        }
      }

      if (dryRun) {
        // Same wire shape as a real run, just with no IDs on the
        // good rows — they'd be created on the next call.
        const results = validated.map((v) =>
          v.ok
            ? { index: v.index, ok: true as const }
            : { index: v.index, ok: false as const, error: v.error },
        );
        const succeeded = results.filter((r) => r.ok).length;
        const failed = results.length - succeeded;
        return reply
          .code(207)
          .send({ results, succeeded, failed, dryRun: true });
      }

      // Commit phase — only rows that passed validation. Failures are
      // merged back into the result list at their original index so the
      // operator sees them line-by-line.
      const validInputs = validated.flatMap((v) =>
        v.ok
          ? [
              {
                ...v.data,
                dateOfBirth: new Date(v.data.dateOfBirth),
                hireDate: v.data.hireDate
                  ? new Date(v.data.hireDate)
                  : undefined,
                regularizationDate: v.data.regularizationDate
                  ? new Date(v.data.regularizationDate)
                  : undefined,
                spouseDateOfBirth: v.data.spouseDateOfBirth
                  ? new Date(v.data.spouseDateOfBirth)
                  : undefined,
                _originalIndex: v.index,
              },
            ]
          : [],
      );

      const createResults = await customers.bulkCreate(
        validInputs.map(({ _originalIndex, ...input }) => {
          void _originalIndex;
          return input;
        }),
        { stopOnError },
      );

      // Best-effort AML screen on each successful creation. Errors are
      // non-fatal — the scheduled job picks up PENDING customers later.
      for (const r of createResults) {
        if (r.ok && r.id) {
          void app.screening.screen(r.id).catch(() => undefined);
        }
      }

      // Merge with validation failures, indexed by the original CSV row.
      type RowOut =
        | { index: number; ok: true; id: string; number: string }
        | { index: number; ok: false; error: string };
      const byIndex = new Map<number, RowOut>();
      for (let j = 0; j < createResults.length; j++) {
        const r = createResults[j]!;
        const original = validInputs[j]?._originalIndex ?? r.index;
        if (r.ok && r.id && r.number) {
          byIndex.set(original, {
            index: original,
            ok: true,
            id: r.id,
            number: r.number,
          });
        } else {
          byIndex.set(original, {
            index: original,
            ok: false,
            error: r.error ?? "Create failed",
          });
        }
      }
      for (const v of validated) {
        if (!v.ok)
          byIndex.set(v.index, { index: v.index, ok: false, error: v.error });
      }
      const merged = [...byIndex.values()].sort((a, b) => a.index - b.index);
      const succeeded = merged.filter((r) => r.ok).length;
      const failed = merged.length - succeeded;
      return reply
        .code(207)
        .send({ results: merged, succeeded, failed, dryRun: false });
    },
  );

  /**
   * Customer rollup — used by the drawer for a quick view without
   * navigating off the current page. Returns the base customer record
   * plus active-loans count and outstanding principal across all
   * open loans (status in DISBURSED / ACTIVE / DEFAULTED).
   */
  app.get<{ Params: { id: string } }>("/:id/summary", async (req, reply) => {
    const customer = await customers.findByIdOrNumber(req.params.id);
    if (!customer) return reply.code(404).send({ error: "NotFound" });

    const loans = await app.prisma.loanApplication.findMany({
      where: {
        customerId: customer.id,
        status: { in: ["DISBURSED", "ACTIVE", "DEFAULTED"] },
      },
      include: {
        schedule: {
          where: { paidInFullAt: null },
          select: { totalDue: true, principalPaid: true },
        },
      },
    });

    let outstanding = 0;
    for (const l of loans) {
      for (const s of l.schedule) {
        outstanding += Number(s.totalDue) - Number(s.principalPaid);
      }
    }

    const totalLoansCount = await app.prisma.loanApplication.count({
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
  });

  /**
   * Repeat-loan eligibility (FRD §3.1.1). A customer is eligible when
   * they have at least one CLOSED loan and no DEFAULTED / WRITTEN_OFF in
   * history. We return the rollup so the application form can show a
   * "Repeat borrower" badge and pre-populate KYC re-use hints.
   */
  app.get<{ Params: { id: string } }>(
    "/:id/repeat-eligibility",
    async (req, reply) => {
      const customer = await customers.findByIdOrNumber(req.params.id);
      if (!customer) return reply.code(404).send({ error: "NotFound" });

      const loans = await app.prisma.loanApplication.findMany({
        where: { customerId: customer.id },
        select: { id: true, status: true, closedAt: true, isRepeat: true },
        orderBy: { submittedAt: "desc" },
      });

      const closedCount = loans.filter((l) => l.status === "CLOSED").length;
      const writtenOff = loans.filter((l) => l.status === "WRITTEN_OFF").length;
      const defaulted = loans.filter((l) => l.status === "DEFAULTED").length;
      const lastClosedAt =
        loans.find((l) => l.status === "CLOSED")?.closedAt ?? null;

      // FRD: "completed repayment of the previous loan (or be in good standing)"
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
    },
  );

  /**
   * Customer ledger — unified statement of account aggregating loan
   * activity (disbursements / payments / penalty waivers) and
   * cooperative activity (contributions, savings) into a single
   * chronological stream + per-section summary totals.
   *
   * Query params:
   *   ?from=YYYY-MM-DD       inclusive lower bound
   *   ?to=YYYY-MM-DD         inclusive upper bound
   *   ?scope=ALL|LOANS|COOP  default ALL
   *   ?format=json|csv       default json; csv streams an exportable file
   *
   * Anyone with customers.read can pull a ledger — useful for officers
   * preparing a statement of account, treasury reconciliation, etc.
   */
  app.get<{
    Params: { id: string };
    Querystring: {
      from?: string;
      to?: string;
      scope?: string;
      format?: string;
    };
  }>("/:id/ledger", async (req, reply) => {
    const existing = await customers.findByIdOrNumber(req.params.id);
    if (!existing) return reply.code(404).send({ error: "NotFound" });

    const parsedScope = (req.query.scope ?? "ALL").toUpperCase();
    const scope =
      parsedScope === "LOANS" || parsedScope === "COOP" || parsedScope === "ALL"
        ? (parsedScope as "ALL" | "LOANS" | "COOP")
        : "ALL";

    // Parse date bounds defensively — bad input returns a 400 rather
    // than letting `new Date('garbage')` silently become Invalid Date.
    const from = parseDateOr400(req.query.from, reply);
    if (from === FAILED) return;
    const to = parseDateOr400(req.query.to, reply);
    if (to === FAILED) return;

    const ledger = await ledgerRepo.build(existing.id, {
      from: from ?? undefined,
      to: to ?? undefined,
      scope,
    });

    if (req.query.format === "csv") {
      const csv = ledgerToCsv(ledger);
      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header(
        "Content-Disposition",
        `attachment; filename="statement-${existing.number}.csv"`,
      );
      return reply.send(csv);
    }

    return ledger;
  });

  /**
   * PDF rendering of the same data. Streams `application/pdf`. Useful
   * when the operator wants a polished printable statement to hand to
   * the customer, or to attach to an email follow-up.
   */
  app.get<{
    Params: { id: string };
    Querystring: { from?: string; to?: string; scope?: string };
  }>("/:id/ledger.pdf", async (req, reply) => {
    const existing = await customers.findByIdOrNumber(req.params.id);
    if (!existing) return reply.code(404).send({ error: "NotFound" });
    const from = parseDateOr400(req.query.from, reply);
    if (from === FAILED) return;
    const to = parseDateOr400(req.query.to, reply);
    if (to === FAILED) return;
    const parsedScope = (req.query.scope ?? "ALL").toUpperCase();
    const scope =
      parsedScope === "LOANS" || parsedScope === "COOP" || parsedScope === "ALL"
        ? (parsedScope as "ALL" | "LOANS" | "COOP")
        : "ALL";
    const ledger = await ledgerRepo.build(existing.id, {
      from: from ?? undefined,
      to: to ?? undefined,
      scope,
    });
    const branding = await getBranding(app.prisma);
    const buf = await renderCustomerStatement({
      companyName: branding.companyName,
      asOf: new Date(ledger.asOf),
      range: {
        from: ledger.range.from ? new Date(ledger.range.from) : null,
        to: ledger.range.to ? new Date(ledger.range.to) : null,
      },
      scope: ledger.scope,
      customer: ledger.customer,
      summary: ledger.summary,
      entries: ledger.entries.map((e) => ({
        ...e,
        date: new Date(e.date),
      })),
    });
    reply.header("Content-Type", "application/pdf");
    reply.header(
      "Content-Disposition",
      `attachment; filename="statement-${existing.number}.pdf"`,
    );
    return reply.send(buf);
  });

  /**
   * Notify the customer that their statement is ready. We deliberately
   * don't attach the PDF — financial data over plain email is a privacy
   * hazard, and recipients with the right credentials can fetch the
   * statement themselves from the portal. The email is a nudge: "log
   * in and download."
   *
   * Idempotent enough for repeated clicks: each call dispatches a fresh
   * notification (one IN_APP, one EMAIL if the customer has an email
   * on file). Operators rarely double-tap, but if they do, the
   * customer just gets a second copy.
   */
  app.post<{ Params: { id: string } }>(
    "/:id/ledger/email",
    async (req, reply) => {
      const existing = await customers.findByIdOrNumber(req.params.id);
      if (!existing) return reply.code(404).send({ error: "NotFound" });

      const customerName = [
        existing.firstName,
        existing.middleName,
        existing.lastName,
      ]
        .filter(Boolean)
        .join(" ");
      const asOf = new Date().toISOString().slice(0, 10);
      const data = {
        customerName,
        asOf,
      };

      // IN_APP entry so the operator can see the dispatch landed in the bell.
      await app.notifications.dispatch({
        event: "STATEMENT_READY",
        channel: "IN_APP",
        recipient: existing.email ?? existing.phone,
        data,
        refType: "Customer",
        refId: existing.id,
        customerId: existing.id,
      });

      // EMAIL — only if the customer has one. The mock provider just logs;
      // a real provider sends through SendGrid/SES/etc.
      if (existing.email) {
        await app.notifications.dispatch({
          event: "STATEMENT_READY",
          channel: "EMAIL",
          recipient: existing.email,
          data,
          refType: "Customer",
          refId: existing.id,
          customerId: existing.id,
        });
      }

      return reply.code(202).send({
        ok: true,
        sentTo: existing.email ?? null,
        message: existing.email
          ? `Notification dispatched to ${existing.email}.`
          : "Customer has no email on file — in-app notification logged.",
      });
    },
  );

  // PATCH /customers/:idOrNumber — same id-or-number convention. We
  // resolve to the UUID first so the underlying update() still targets
  // the unique primary key.
  app.patch<{ Params: { id: string } }>("/:id", async (req, reply) => {
    const parsed = customerBaseSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const existing = await customers.findByIdOrNumber(req.params.id);
    if (!existing) return reply.code(404).send({ error: "NotFound" });
    return customers.update(existing.id, {
      ...parsed.data,
      dateOfBirth: parsed.data.dateOfBirth
        ? new Date(parsed.data.dateOfBirth)
        : undefined,
      hireDate: parsed.data.hireDate
        ? new Date(parsed.data.hireDate)
        : undefined,
      regularizationDate: parsed.data.regularizationDate
        ? new Date(parsed.data.regularizationDate)
        : undefined,
      spouseDateOfBirth: parsed.data.spouseDateOfBirth
        ? new Date(parsed.data.spouseDateOfBirth)
        : undefined,
    });
  });
}

// ─── ledger helpers ─────────────────────────────────────────────────

/** Sentinel returned by parseDateOr400 when it already sent a 400 reply. */
const FAILED = Symbol("FAILED");

/**
 * Parse an optional ISO date. Returns null when undefined, a Date when
 * valid, or the FAILED sentinel after replying with 400 — the caller
 * just checks `=== FAILED` to know it should bail out.
 */
function parseDateOr400(
  raw: string | undefined,
  reply: import("fastify").FastifyReply,
): Date | null | typeof FAILED {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    reply.code(400).send({
      error: "ValidationError",
      message: `Bad date: ${raw}. Expect ISO YYYY-MM-DD.`,
    });
    return FAILED;
  }
  return d;
}

/**
 * Flatten the ledger into a CSV that opens cleanly in Excel / Sheets.
 * Columns mirror the on-screen table; the summary section is included
 * as commented header lines so a downloaded statement is self-contained.
 *
 * RFC 4180 quoting: anything containing comma, quote, or newline is
 * wrapped in quotes with internal quotes doubled.
 */
function ledgerToCsv(ledger: CustomerLedger): string {
  const esc = (s: string): string =>
    /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  const lines: string[] = [];
  lines.push(
    `# Statement of Account for ${ledger.customer.number} — ${ledger.customer.firstName} ${ledger.customer.lastName}`,
  );
  lines.push(`# As of: ${ledger.asOf}`);
  lines.push(
    `# Range: ${ledger.range.from ?? "all time"} → ${ledger.range.to ?? "now"}; scope ${ledger.scope}`,
  );
  lines.push("#");
  lines.push(`# Summary`);
  lines.push(`#   Total disbursed:        ${ledger.summary.totalDisbursed}`);
  lines.push(`#   Total repaid:           ${ledger.summary.totalRepaid}`);
  lines.push(
    `#   Outstanding principal:  ${ledger.summary.outstandingPrincipal}`,
  );
  lines.push(
    `#   Penalty waived:         ${ledger.summary.totalPenaltyWaived}`,
  );
  lines.push(`#   Savings balance:        ${ledger.summary.savingsBalance}`);
  lines.push(
    `#   Contributions total:    ${ledger.summary.contributionsTotal}`,
  );
  lines.push(
    `#   Net customer position:  ${ledger.summary.netCustomerPosition}`,
  );
  lines.push(`#`);
  lines.push(
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
  );
  for (const e of ledger.entries) {
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
  return lines.join("\r\n") + "\r\n";
}
