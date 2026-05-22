/**
 * Statement of Account — full picture of the loan as of a given date.
 *   - Loan summary (terms + status + customer)
 *   - Full schedule with paid / unpaid marks
 *   - Payment history
 *   - Computed balance
 */

import {
  CONTENT_WIDTH,
  fmtDate,
  footer,
  kv,
  moneyPHP,
  pct,
  personnelStamp,
  section,
  startDoc,
  table,
  type PersonnelSignature,
} from "./chrome";

export interface StatementInput {
  companyName: string;
  asOf: Date;

  loan: {
    number: string;
    productCode: string;
    productName?: string;
    principal: number;
    termMonths: number;
    annualInterestRate: number;
    status: string;
    submittedAt: Date;
    disbursedAt: Date | null;
    closedAt: Date | null;
  };

  customer: {
    firstName: string;
    middleName?: string | null;
    lastName: string;
    address?: string | null;
    city?: string | null;
  };

  schedule: Array<{
    installmentNo: number;
    dueDate: Date;
    principalDue: number;
    interestDue: number;
    totalDue: number;
    paidInFullAt: Date | null;
    principalPaid: number;
  }>;

  payments: Array<{
    id: string;
    amount: number;
    paidOn: Date;
    reference?: string | null;
  }>;

  /** Optional personnel signature — "Prepared by" block at the bottom. */
  personnelSignature?: PersonnelSignature | null;
}

export function renderStatementOfAccount(
  input: StatementInput,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = startDoc({
        companyName: input.companyName,
        title: "Statement of Account",
        documentNumber: `${input.loan.number} · as of ${fmtDate(input.asOf)}`,
      });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const fullName = [
        input.customer.firstName,
        input.customer.middleName,
        input.customer.lastName,
      ]
        .filter(Boolean)
        .join(" ");
      const totalPaid = input.payments.reduce((s, p) => s + p.amount, 0);
      const remainingPrincipal = input.schedule
        .filter((s) => !s.paidInFullAt)
        .reduce((s, x) => s + (x.principalDue - x.principalPaid), 0);

      section(doc, "Loan summary");
      kv(doc, "Loan number", input.loan.number);
      kv(doc, "Product", input.loan.productName ?? input.loan.productCode);
      kv(doc, "Borrower", fullName);
      if (input.customer.address) {
        kv(
          doc,
          "Address",
          `${input.customer.address}, ${input.customer.city ?? ""}`,
        );
      }
      kv(doc, "Principal", moneyPHP(input.loan.principal));
      kv(doc, "Annual rate", pct(input.loan.annualInterestRate));
      kv(doc, "Term", `${input.loan.termMonths} months`);
      kv(doc, "Status", input.loan.status);
      kv(doc, "Submitted", fmtDate(input.loan.submittedAt));
      kv(doc, "Disbursed", fmtDate(input.loan.disbursedAt));
      if (input.loan.closedAt) kv(doc, "Closed", fmtDate(input.loan.closedAt));

      section(doc, "Position as of " + fmtDate(input.asOf));
      kv(doc, "Total payments received", moneyPHP(totalPaid));
      kv(doc, "Remaining principal", moneyPHP(remainingPrincipal));

      section(doc, "Amortization schedule");
      table(
        doc,
        input.schedule.map((s) => [
          String(s.installmentNo),
          fmtDate(s.dueDate),
          moneyPHP(s.principalDue),
          moneyPHP(s.interestDue),
          moneyPHP(s.totalDue),
          s.paidInFullAt ? `Paid ${fmtDate(s.paidInFullAt)}` : "Unpaid",
        ]),
        {
          header: ["#", "Due date", "Principal", "Interest", "Total", "Status"],
          columnWidths: [
            CONTENT_WIDTH * 0.06,
            CONTENT_WIDTH * 0.16,
            CONTENT_WIDTH * 0.18,
            CONTENT_WIDTH * 0.16,
            CONTENT_WIDTH * 0.18,
            CONTENT_WIDTH * 0.26,
          ],
          alignments: ["left", "left", "right", "right", "right", "left"],
        },
      );

      section(doc, "Payment history");
      if (input.payments.length === 0) {
        doc
          .font("Helvetica")
          .fontSize(9)
          .fillColor("#64748b")
          .text("No payments recorded.", { width: CONTENT_WIDTH });
      } else {
        table(
          doc,
          input.payments.map((p) => [
            fmtDate(p.paidOn),
            p.id.slice(0, 8).toUpperCase(),
            p.reference ?? "—",
            moneyPHP(p.amount),
          ]),
          {
            header: ["Paid on", "OR #", "Reference", "Amount"],
            columnWidths: [
              CONTENT_WIDTH * 0.22,
              CONTENT_WIDTH * 0.18,
              CONTENT_WIDTH * 0.4,
              CONTENT_WIDTH * 0.2,
            ],
            alignments: ["left", "left", "left", "right"],
          },
        );
      }

      if (input.personnelSignature) {
        personnelStamp(doc, {
          label: "Prepared by",
          ...input.personnelSignature,
        });
      }

      footer(doc, `${input.companyName} · Statement for ${input.loan.number}`);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
