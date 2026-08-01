#!/usr/bin/env node
/**
 * repair-payments — find and fix loans misstated by the old payment
 * allocation, which ran every payment against each open installment's FULL
 * interest instead of what was actually still owed.
 *
 * Symptoms it looks for, per loan:
 *   - Interest income over-recognized / principal under-credited.
 *   - Installments never flagged `paidInFullAt` because no single payment
 *     covered the whole `totalDue`, so the loan stayed open.
 *   - Overpayments credited to Loans Receivable instead of Customer
 *     Advances (2100).
 *   - Late fees charged after the borrower had in fact settled.
 *
 * Usage:
 *   pnpm --filter @loan/db repair-payments                    # dry run
 *   pnpm --filter @loan/db repair-payments --json out.json    # dry run + machine-readable
 *   pnpm --filter @loan/db repair-payments --apply --posted-by <userId>
 *   pnpm --filter @loan/db repair-payments --all-tenants      # every tenant schema
 *   pnpm --filter @loan/db repair-payments --only acme-corp   # one tenant
 *
 * DRY RUN IS THE DEFAULT. Nothing is written without --apply, and --apply
 * requires --posted-by so the correcting entries carry a real user.
 *
 * What --apply writes, per affected loan, in one transaction:
 *   1. `LoanSchedule.principalPaid` / `interestPaid` / `paidInFullAt` set to
 *      the replayed values.
 *   2. One correcting journal entry moving the misallocated amounts between
 *      Interest Income (4000), Loans Receivable (1100) and Customer Advances
 *      (2100). Cash is untouched — the money received never changed, only
 *      what it was applied to — so the entry balances by construction. It is
 *      tagged `LoanPaymentAllocationRepair` + the loan id and posted through
 *      `postIfAbsent`, so re-running is a no-op.
 *   3. Status set to CLOSED where the replay shows the loan fully settled.
 *
 * What it does NOT do: reverse over-accrued late fees. Those are reported
 * per loan. A penalty may already have been invoiced or partly collected,
 * and the system has a purpose-built, permission-gated path for removing one
 * — `LoanRepository.waivePenalty` — which posts the same reversal AND leaves
 * a `PenaltyWaiver` audit row. Use that.
 *
 * Loans settled by write-off, restructure, repossession, or early closure
 * are skipped and listed: their schedules were marked paid without a
 * matching payment allocation, so replaying them would fabricate history.
 */

import { writeFileSync } from "node:fs";

import { PrismaClient } from "@prisma/client";

import { AccountingRepository } from "../src/repositories/accounting.repository.ts";
import {
  REPAIR_SOURCE_REF_TYPE,
  auditLoan,
  repairEntryLines,
} from "../src/lib/repair-payment-allocations.ts";
import { tenantDatabaseUrl } from "../src/lib/multi-tenant-migrate.ts";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const ALL_TENANTS = args.includes("--all-tenants");
const ONLY = takeArg("--only");
const POSTED_BY = takeArg("--posted-by");
const JSON_OUT = takeArg("--json");

function takeArg(name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  return args[idx + 1] ?? null;
}

function log(line, level = "info") {
  const prefix = level === "error" ? "✗" : level === "warn" ? "!" : "·";
  process.stdout.write(`${prefix} ${line}\n`);
}

function money(n) {
  const s = n.toFixed(2);
  return n > 0 ? `+${s}` : s;
}

if (APPLY && !POSTED_BY) {
  log(
    "--apply requires --posted-by <userId>: correcting entries need an author.",
    "error",
  );
  process.exit(1);
}

// ─── Per-schema audit ─────────────────────────────────────────────────────

async function auditSchema(prisma, label) {
  const accounting = new AccountingRepository(prisma);

  // Only loans that have taken at least one payment can be misallocated.
  const loans = await prisma.loanApplication.findMany({
    where: { payments: { some: {} } },
    include: {
      schedule: { orderBy: { installmentNo: "asc" } },
      payments: { orderBy: { paidOn: "asc" } },
    },
  });

  const repossessed = new Set(
    (await prisma.repossessionCase.findMany({ select: { loanId: true } })).map(
      (c) => c.loanId,
    ),
  );

  const audits = [];
  for (const loan of loans) {
    const paymentIds = loan.payments.map((p) => p.id);
    const scheduleIds = loan.schedule.map((s) => s.id);

    const entries = await prisma.journalEntry.findMany({
      where: {
        OR: [
          {
            source: "LOAN_PAYMENT",
            sourceRefType: "LoanPayment",
            sourceRefId: { in: paymentIds },
          },
          ...(scheduleIds.length > 0
            ? [
                {
                  source: "LATE_FEE_ACCRUAL",
                  sourceRefType: "LoanScheduleLateFee",
                  OR: scheduleIds.map((sid) => ({
                    sourceRefId: { startsWith: `${sid}:` },
                  })),
                },
              ]
            : []),
          // Corrections a previous run already posted — netted out by the
          // auditor so a repaired loan stops being reported as broken.
          {
            sourceRefType: REPAIR_SOURCE_REF_TYPE,
            sourceRefId: loan.id,
          },
        ],
      },
      include: { lines: { include: { account: true } } },
    });

    let forceSettledBy = null;
    if (loan.status === "WRITTEN_OFF") forceSettledBy = "written off";
    else if (loan.status === "RESTRUCTURED") forceSettledBy = "restructured";
    else if (repossessed.has(loan.id)) forceSettledBy = "repossessed";

    audits.push(
      auditLoan({
        id: loan.id,
        number: loan.number,
        status: loan.status,
        forceSettledBy,
        schedule: loan.schedule.map((s) => ({
          id: s.id,
          installmentNo: s.installmentNo,
          principalDue: Number(s.principalDue),
          interestDue: Number(s.interestDue),
          principalPaid: Number(s.principalPaid),
          interestPaid: Number(s.interestPaid),
          paidInFullAt: s.paidInFullAt,
        })),
        payments: loan.payments.map((p) => ({
          id: p.id,
          amount: Number(p.amount),
          paidOn: p.paidOn,
          reference: p.reference,
        })),
        entries: entries.map((e) => ({
          id: e.id,
          entryDate: e.entryDate,
          source: e.source,
          sourceRefType: e.sourceRefType,
          sourceRefId: e.sourceRefId,
          lines: e.lines.map((l) => ({
            accountCode: l.account.code,
            debit: Number(l.debit),
            credit: Number(l.credit),
          })),
        })),
      }),
    );
  }

  report(label, audits);
  if (APPLY) await applyAll(prisma, accounting, audits);
  return audits;
}

function report(label, audits) {
  const skipped = audits.filter((a) => a.skipReason);
  const dirty = audits.filter((a) => !a.skipReason && !a.clean);
  const clean = audits.filter((a) => !a.skipReason && a.clean);

  process.stdout.write(`\n=== ${label} ===\n`);
  log(
    `${audits.length} loans with payments — ${clean.length} correct, ${dirty.length} misstated, ${skipped.length} need manual review`,
  );

  for (const a of dirty) {
    const bits = [];
    if (Math.abs(a.delta.interest) > 0.005)
      bits.push(`interest ${money(a.delta.interest)}`);
    if (Math.abs(a.delta.principal) > 0.005)
      bits.push(`principal ${money(a.delta.principal)}`);
    if (Math.abs(a.delta.advance) > 0.005)
      bits.push(`advance ${money(a.delta.advance)}`);
    const scheduleFixes = a.schedule.filter((s) => s.changed).length;
    if (scheduleFixes > 0) bits.push(`${scheduleFixes} schedule rows`);
    if (a.shouldClose) bits.push("should be CLOSED");
    if (a.unpostedPaymentIds.length > 0) {
      bits.push(
        `${a.unpostedPaymentIds.length} payments never posted (post by hand: ${a.unpostedPaymentIds.join(", ")})`,
      );
    }
    if (a.lateFeeOverAccrued > 0.005)
      bits.push(`late fees over-accrued ${a.lateFeeOverAccrued.toFixed(2)}`);
    log(`${a.loanNumber} (${a.status}): ${bits.join(", ")}`, "warn");
  }

  for (const a of skipped) {
    log(`${a.loanNumber} (${a.status}): ${a.skipReason}`, "warn");
  }

  const totals = dirty.reduce(
    (acc, a) => ({
      interest: acc.interest + a.delta.interest,
      principal: acc.principal + a.delta.principal,
      advance: acc.advance + a.delta.advance,
      lateFees: acc.lateFees + a.lateFeeOverAccrued,
    }),
    { interest: 0, principal: 0, advance: 0, lateFees: 0 },
  );
  if (dirty.length > 0) {
    log(
      `Net correction — interest ${money(totals.interest)}, principal ${money(totals.principal)}, advances ${money(totals.advance)}`,
    );
    if (totals.lateFees > 0.005) {
      log(
        `Late fees accrued after settlement: ${totals.lateFees.toFixed(2)} across ${dirty.filter((a) => a.lateFeeOverAccrued > 0.005).length} loans. Not reversed here — use waivePenalty.`,
        "warn",
      );
    }
  }
  if (!APPLY && (dirty.length > 0 || skipped.length > 0)) {
    log("Dry run — nothing written. Re-run with --apply --posted-by <userId>.");
  }
}

async function applyAll(prisma, accounting, audits) {
  const dirty = audits.filter((a) => !a.skipReason && !a.clean);
  let fixed = 0;
  for (const a of dirty) {
    await prisma.$transaction(async (tx) => {
      for (const row of a.schedule) {
        if (!row.changed) continue;
        await tx.loanSchedule.update({
          where: { id: row.id },
          data: {
            principalPaid: row.principalPaid,
            interestPaid: row.interestPaid,
            paidInFullAt: row.paidInFullAt,
          },
        });
      }

      const lines = repairEntryLines(a);
      if (lines) {
        await accounting.postIfAbsent(
          {
            entryDate: new Date(),
            source: "ADJUSTMENT",
            sourceRefType: REPAIR_SOURCE_REF_TYPE,
            sourceRefId: a.loanId,
            memo: `Re-allocate payments on ${a.loanNumber} (partial-payment allocation repair)`,
            lines,
          },
          { postedById: POSTED_BY, tx },
        );
      }

      if (a.shouldClose) {
        await tx.loanApplication.update({
          where: { id: a.loanId },
          data: { status: "CLOSED", closedAt: new Date() },
        });
      }
    });
    fixed += 1;
    log(`repaired ${a.loanNumber}`);
  }
  log(`Applied ${fixed} repairs.`);
}

// ─── Entry point ──────────────────────────────────────────────────────────

async function main() {
  const results = {};

  if (!ALL_TENANTS && !ONLY) {
    const prisma = new PrismaClient();
    try {
      results.default = await auditSchema(prisma, "default schema");
    } finally {
      await prisma.$disconnect();
    }
  } else {
    const control = new PrismaClient();
    let tenants;
    try {
      tenants = await control.tenant.findMany({
        where: ONLY ? { slug: ONLY } : { status: { not: "ARCHIVED" } },
        select: { slug: true, name: true },
        orderBy: { slug: "asc" },
      });
    } finally {
      await control.$disconnect();
    }
    if (tenants.length === 0) {
      log(ONLY ? `No tenant with slug "${ONLY}".` : "No tenants.", "warn");
      return;
    }
    const base = process.env.DATABASE_URL;
    if (!base) {
      log("DATABASE_URL is not set.", "error");
      process.exitCode = 1;
      return;
    }
    for (const tenant of tenants) {
      const prisma = new PrismaClient({
        datasources: {
          db: {
            url: tenantDatabaseUrl(base, tenant.slug, { connectionLimit: 2 }),
          },
        },
      });
      try {
        results[tenant.slug] = await auditSchema(
          prisma,
          `${tenant.name} (${tenant.slug})`,
        );
      } catch (err) {
        log(`${tenant.slug}: ${err.message}`, "error");
        process.exitCode = 1;
      } finally {
        await prisma.$disconnect();
      }
    }
  }

  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
    log(`Wrote ${JSON_OUT}`);
  }
}

main().catch((err) => {
  log(err.stack ?? String(err), "error");
  process.exit(1);
});
