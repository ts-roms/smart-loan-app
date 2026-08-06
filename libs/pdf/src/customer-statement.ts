/**
 * Customer Statement of Account — unified per-customer statement
 * combining loan activity and cooperative activity into one document.
 *
 * Different from `renderStatementOfAccount` in `statement.ts`, which is
 * scoped to a single loan and includes the amortization schedule. This
 * renderer is the "bank statement" view: all customer-level activity
 * in chronological order with a running balance + section totals.
 *
 * Pure: data in, Buffer out. The API route streams the result as
 * `Content-Type: application/pdf`; nothing is persisted to disk.
 */

import {
  CONTENT_WIDTH,
  fmtDate,
  footer,
  kv,
  moneyPHP,
  personnelStamp,
  section,
  startDoc,
  table,
  type PersonnelSignature,
} from "./chrome";

export type CustomerStatementEntryKind =
  | "LOAN_DISBURSEMENT"
  | "LOAN_PAYMENT"
  | "PENALTY_WAIVER"
  | "CONTRIBUTION"
  | "SAVINGS_DEPOSIT"
  | "SAVINGS_WITHDRAWAL";

export type CustomerStatementDirection = "INFLOW" | "OUTFLOW";

export interface CustomerStatementEntry {
  date: Date | string;
  kind: CustomerStatementEntryKind;
  description: string;
  amount: number;
  direction: CustomerStatementDirection;
  loanNumber?: string | null;
  owedAfter: number;
  heldAfter: number;
}

export interface CustomerStatementInput {
  companyName: string;
  asOf: Date;
  range?: { from?: Date | null; to?: Date | null };
  scope?: "ALL" | "LOANS" | "COOP";

  customer: {
    /** Human-readable reference number ("CUST-2026-…"). */
    number: string;
    firstName: string;
    middleName?: string | null;
    lastName: string;
    email?: string | null;
    phone?: string | null;
  };

  summary: {
    totalDisbursed: number;
    totalRepaid: number;
    outstandingPrincipal: number;
    totalPenaltyWaived: number;
    savingsBalance: number;
    contributionsTotal: number;
    capitalBuildUp: number;
    mortuaryFund: number;
    emergencyFund: number;
    amountOwed: number;
    amountHeld: number;
  };

  entries: CustomerStatementEntry[];

  personnelSignature?: PersonnelSignature | null;
}

/**
 * Build a printable PDF representing the customer's full account
 * activity. Layout:
 *
 *   1. Header bar (company name + title + as-of date)
 *   2. Customer block (name, reference, email/phone)
 *   3. Position summary (5-line snapshot)
 *   4. Section split:
 *      - Loans subtotals
 *      - Cooperative subtotals
 *   5. Activity table (date / kind / description / in / out / balance)
 *   6. Optional "Prepared by" personnel stamp + footer
 */
export function renderCustomerStatement(
  input: CustomerStatementInput,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const fullName = [
        input.customer.firstName,
        input.customer.middleName,
        input.customer.lastName,
      ]
        .filter(Boolean)
        .join(" ");

      const doc = startDoc({
        companyName: input.companyName,
        title: "Statement of Account",
        documentNumber: `${input.customer.number} · as of ${fmtDate(input.asOf)}`,
      });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      // ── Customer + scope context ────────────────────────────────
      section(doc, "Customer");
      kv(doc, "Reference", input.customer.number);
      kv(doc, "Name", fullName);
      if (input.customer.email) kv(doc, "Email", input.customer.email);
      if (input.customer.phone) kv(doc, "Phone", input.customer.phone);

      if (input.range && (input.range.from || input.range.to)) {
        kv(
          doc,
          "Period",
          `${input.range.from ? fmtDate(input.range.from) : "beginning"} → ${
            input.range.to ? fmtDate(input.range.to) : "now"
          }`,
        );
      } else {
        kv(doc, "Period", "All-time");
      }
      kv(doc, "Scope", input.scope ?? "ALL");

      // ── Position summary ────────────────────────────────────────
      section(doc, "Position as of " + fmtDate(input.asOf));
      kv(doc, "Total disbursed", moneyPHP(input.summary.totalDisbursed));
      kv(doc, "Total repaid", moneyPHP(input.summary.totalRepaid));
      kv(
        doc,
        "Outstanding principal",
        moneyPHP(input.summary.outstandingPrincipal),
      );
      if (input.summary.totalPenaltyWaived > 0) {
        kv(doc, "Penalty waived", moneyPHP(input.summary.totalPenaltyWaived));
      }
      kv(doc, "Savings balance", moneyPHP(input.summary.savingsBalance));
      kv(
        doc,
        "Contributions total",
        moneyPHP(input.summary.contributionsTotal),
      );
      /*
       * Two lines, never one. The single "net position" they replace
       * added a debt the member was settling to savings they did not
       * have, so a borrower's interest came out looking like a deposit
       * on their own statement.
       */
      kv(doc, "You owe the coop", moneyPHP(input.summary.amountOwed));
      kv(doc, "Coop holds for you", moneyPHP(input.summary.amountHeld));

      // ── Subtotal split for at-a-glance reading ──────────────────
      section(doc, "Cooperative balances");
      kv(doc, "Capital build-up", moneyPHP(input.summary.capitalBuildUp));
      kv(doc, "Mortuary fund", moneyPHP(input.summary.mortuaryFund));
      kv(doc, "Emergency fund", moneyPHP(input.summary.emergencyFund));

      // ── Activity table ──────────────────────────────────────────
      section(doc, "Activity");
      if (input.entries.length === 0) {
        doc
          .font("Helvetica")
          .fontSize(9)
          .fillColor("#64748b")
          .text("No activity in this range.", { width: CONTENT_WIDTH });
      } else {
        table(
          doc,
          input.entries.map((e) => [
            fmtDate(e.date),
            kindLabel(e.kind),
            entryDescription(e),
            e.direction === "INFLOW" ? moneyPHP(e.amount) : "",
            e.direction === "OUTFLOW" ? moneyPHP(e.amount) : "",
            moneyPHP(e.owedAfter),
            moneyPHP(e.heldAfter),
          ]),
          {
            header: [
              "Date",
              "Kind",
              "Description",
              "In",
              "Out",
              "Owed",
              "Held",
            ],
            // Seven columns now, and the fractions have to still sum
            // to 1 — Description gives up the room the new Held column
            // needs, since it is the one that can wrap.
            columnWidths: [
              CONTENT_WIDTH * 0.11,
              CONTENT_WIDTH * 0.13,
              CONTENT_WIDTH * 0.28,
              CONTENT_WIDTH * 0.12,
              CONTENT_WIDTH * 0.12,
              CONTENT_WIDTH * 0.12,
              CONTENT_WIDTH * 0.12,
            ],
            alignments: [
              "left",
              "left",
              "left",
              "right",
              "right",
              "right",
              "right",
            ],
          },
        );
      }

      if (input.personnelSignature) {
        personnelStamp(doc, {
          label: "Prepared by",
          ...input.personnelSignature,
        });
      }

      footer(
        doc,
        `${input.companyName} · Statement for ${input.customer.number} · ${fullName}`,
      );
      doc.end();
    } catch (err) {
      // See agreement.ts — normalize so callers always get an Error.
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// ─── helpers ────────────────────────────────────────────────────────

const KIND_LABELS: Record<CustomerStatementEntryKind, string> = {
  LOAN_DISBURSEMENT: "Loan disbursed",
  LOAN_PAYMENT: "Loan payment",
  PENALTY_WAIVER: "Penalty waived",
  CONTRIBUTION: "Contribution",
  SAVINGS_DEPOSIT: "Savings deposit",
  SAVINGS_WITHDRAWAL: "Savings withdrawal",
};

function kindLabel(k: CustomerStatementEntryKind): string {
  return KIND_LABELS[k];
}

/**
 * Append the loan number to the description when the entry is loan-related,
 * so the operator handing this to a customer doesn't need a separate column.
 * Kept short — long descriptions wrap awkwardly inside a table cell.
 */
function entryDescription(e: CustomerStatementEntry): string {
  if (e.loanNumber && !e.description.includes(e.loanNumber)) {
    return `${e.description} · ${e.loanNumber}`;
  }
  return e.description;
}
