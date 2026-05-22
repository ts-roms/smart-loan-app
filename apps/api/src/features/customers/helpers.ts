import type { CustomerLedger } from "@loan/db";
import type { FastifyReply } from "fastify";

import type { LedgerScope } from "./schemas.js";

/** Sentinel returned by parseDateOr400 when it already sent a 400 reply. */
export const FAILED = Symbol("FAILED");
export type Failed = typeof FAILED;

/**
 * Parse an optional ISO date. Returns null when undefined, a Date when
 * valid, or the FAILED sentinel after replying with 400 — the caller
 * just checks `=== FAILED` to know it should bail out.
 */
export function parseDateOr400(
  raw: string | undefined,
  reply: FastifyReply,
): Date | null | Failed {
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
 * Narrow the wire `scope` query param to the typed `LedgerScope` union,
 * falling back to ALL for anything unrecognised. Centralised so the JSON
 * and PDF endpoints don't drift in how they coerce.
 */
export function normalizeScope(raw: string | undefined): LedgerScope {
  const u = (raw ?? "ALL").toUpperCase();
  return u === "LOANS" || u === "COOP" || u === "ALL"
    ? (u as LedgerScope)
    : "ALL";
}

/**
 * Convert an optional ISO date string from a write payload into a Date
 * for Prisma. Repeated four times in the old route file — keeping the
 * coercion in one place avoids drift if the contract changes.
 */
export function toDateOrUndefined(
  s: string | undefined | null,
): Date | undefined {
  return s ? new Date(s) : undefined;
}

/**
 * Flatten the ledger into a CSV that opens cleanly in Excel / Sheets.
 * Columns mirror the on-screen table; the summary section is included
 * as commented header lines so a downloaded statement is self-contained.
 *
 * RFC 4180 quoting: anything containing comma, quote, or newline is
 * wrapped in quotes with internal quotes doubled.
 */
export function ledgerToCsv(ledger: CustomerLedger): string {
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
