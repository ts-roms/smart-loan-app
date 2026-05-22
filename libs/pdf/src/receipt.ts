/**
 * Payment receipt — single-page acknowledgment of a payment posted against
 * a loan. Shows the allocation (how much went to interest vs principal),
 * the remaining outstanding, and the lender's reference numbers.
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

export interface PaymentReceiptInput {
  companyName: string;
  payment: {
    id: string;
    amount: number;
    paidOn: Date;
    reference?: string | null;
    recordedAt?: Date;
  };
  loan: {
    number: string;
    productCode: string;
  };
  customer: {
    firstName: string;
    middleName?: string | null;
    lastName: string;
  };
  /** Optional allocation hint — splits the amount into interest + principal. */
  allocation?: {
    interest: number;
    principal: number;
  };
  /** Remaining outstanding after this payment. */
  remainingOutstanding?: number;

  /** Optional personnel signature — "Issued by" block at the bottom. */
  personnelSignature?: PersonnelSignature | null;
}

export function renderPaymentReceipt(
  input: PaymentReceiptInput,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = startDoc({
        companyName: input.companyName,
        title: "Official Receipt",
        documentNumber: `OR-${input.payment.id.slice(0, 8).toUpperCase()}`,
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

      section(doc, "Received from");
      kv(doc, "Name", fullName);
      kv(doc, "Loan number", input.loan.number);
      kv(doc, "Product", input.loan.productCode);

      section(doc, "Payment details");
      kv(doc, "Amount received", moneyPHP(input.payment.amount));
      kv(doc, "Paid on", fmtDate(input.payment.paidOn));
      kv(doc, "Lender reference", input.payment.id.slice(0, 8).toUpperCase());
      if (input.payment.reference) {
        kv(doc, "Customer reference", input.payment.reference);
      }

      if (input.allocation) {
        section(doc, "Allocation");
        table(
          doc,
          [
            ["Interest", moneyPHP(input.allocation.interest)],
            ["Principal", moneyPHP(input.allocation.principal)],
          ],
          {
            header: ["Component", "Amount"],
            columnWidths: [CONTENT_WIDTH * 0.6, CONTENT_WIDTH * 0.4],
            alignments: ["left", "right"],
          },
        );
      }

      if (input.remainingOutstanding != null) {
        section(doc, "Outstanding balance after payment");
        kv(doc, "Remaining balance", moneyPHP(input.remainingOutstanding));
      }

      doc.moveDown(2);
      doc
        .font("Helvetica")
        .fontSize(9)
        .fillColor("#475569")
        .text(
          "This receipt is a confirmation that the above payment was received and posted to the loan " +
            "account. Please retain it for your records.",
          { width: CONTENT_WIDTH },
        );

      if (input.personnelSignature) {
        personnelStamp(doc, {
          label: "Issued by",
          ...input.personnelSignature,
        });
      }

      footer(doc, `${input.companyName} · Loan ${input.loan.number}`);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
