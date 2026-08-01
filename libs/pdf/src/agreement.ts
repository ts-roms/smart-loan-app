/**
 * Loan agreement renderer. The body is a formal disclosure of the terms +
 * the standard PH Truth-in-Lending (TIL) summary required by BSP for
 * non-bank lenders. Boilerplate sections (governing law, default, etc.)
 * are intentionally short; real production deployments should review the
 * text with counsel and pull from a customer-editable template store.
 */

import {
  CONTENT_WIDTH,
  fmtDate,
  footer,
  kv,
  moneyPHP,
  paragraph,
  pct,
  personnelStamp,
  section,
  signatureBlock,
  startDoc,
  table,
  type PersonnelSignature,
} from "./chrome";

export interface LoanAgreementInput {
  companyName: string;

  loan: {
    number: string;
    productCode: string;
    productName?: string;
    principal: number;
    termMonths: number;
    annualInterestRate: number;
    purpose?: string | null;
    submittedAt: Date;
    interestMethod: "DECLINING" | "FLAT";
    paymentFrequency: "MONTHLY" | "BIWEEKLY" | "WEEKLY";
  };

  customer: {
    firstName: string;
    middleName?: string | null;
    lastName: string;
    address: string;
    city: string;
    governmentIdType: string;
    governmentIdNumber: string;
  };

  fees: {
    processing: number;
    documentary: number;
    total: number;
    netDisbursement: number;
  };

  schedule: Array<{
    installmentNo: number;
    dueDate: Date;
    principal: number;
    interest: number;
    payment: number;
  }>;

  coMakers?: Array<{
    fullName: string;
    role: string;
    relationship?: string | null;
    signature?: Buffer | null;
    signedAt?: Date | null;
  }>;

  /** Captured borrower signature (PNG buffer). Embedded above the line. */
  borrowerSignature?: Buffer | null;
  borrowerSignedAt?: Date | null;
  officerSignature?: Buffer | null;
  officerSignedAt?: Date | null;
  officerName?: string | null;

  /**
   * Optional personnel signature — the staff member who *prepared* and
   * downloaded this document. Renders as a small "Prepared by" stamp
   * separate from the borrower/officer signature block. Omitting it just
   * skips the stamp.
   */
  personnelSignature?: PersonnelSignature | null;
}

export function renderLoanAgreement(
  input: LoanAgreementInput,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = startDoc({
        companyName: input.companyName,
        title: "Loan Agreement",
        documentNumber: input.loan.number,
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
      const totalPayments = input.schedule.reduce((s, r) => s + r.payment, 0);
      const totalInterest = totalPayments - input.loan.principal;
      const periodLabel =
        input.loan.paymentFrequency === "MONTHLY"
          ? "monthly"
          : input.loan.paymentFrequency === "BIWEEKLY"
            ? "bi-weekly"
            : "weekly";

      section(doc, "Parties");
      paragraph(
        doc,
        `This Loan Agreement is entered into on ${fmtDate(input.loan.submittedAt)} between ` +
          `${input.companyName} ("Lender") and ${fullName} of ${input.customer.address}, ${input.customer.city} ("Borrower"). ` +
          `The Borrower is identified by ${input.customer.governmentIdType} number ${input.customer.governmentIdNumber}.`,
      );

      section(doc, "Terms of the Loan");
      kv(doc, "Loan number", input.loan.number);
      kv(doc, "Product", input.loan.productName ?? input.loan.productCode);
      kv(doc, "Principal amount", moneyPHP(input.loan.principal));
      kv(doc, "Annual interest rate", pct(input.loan.annualInterestRate));
      kv(
        doc,
        "Interest method",
        input.loan.interestMethod === "FLAT"
          ? "Flat / add-on"
          : "Declining balance",
      );
      kv(
        doc,
        "Term",
        `${input.loan.termMonths} months (${input.schedule.length} ${periodLabel} installments)`,
      );
      if (input.loan.purpose) kv(doc, "Purpose", input.loan.purpose);

      section(doc, "Truth-in-Lending Disclosure");
      paragraph(
        doc,
        "In compliance with the Truth-in-Lending Act (RA 3765), the Lender hereby discloses the " +
          "following:",
      );
      kv(doc, "Cash price / amount of credit", moneyPHP(input.loan.principal));
      kv(doc, "Processing fee", moneyPHP(input.fees.processing));
      kv(doc, "Documentary stamp tax", moneyPHP(input.fees.documentary));
      kv(doc, "Other charges", moneyPHP(0));
      kv(doc, "Total non-finance charges", moneyPHP(input.fees.total));
      kv(doc, "Net proceeds to Borrower", moneyPHP(input.fees.netDisbursement));
      kv(doc, "Total interest over loan life", moneyPHP(totalInterest));
      kv(
        doc,
        "Total finance charge",
        moneyPHP(totalInterest + input.fees.total),
      );
      kv(doc, "Total amount payable", moneyPHP(totalPayments));

      section(doc, "Repayment Schedule");
      // Cap to first 12 rows; full schedule visible in Statement of Account.
      const showRows = input.schedule.slice(0, 12);
      table(
        doc,
        showRows.map((r) => [
          String(r.installmentNo),
          fmtDate(r.dueDate),
          moneyPHP(r.principal),
          moneyPHP(r.interest),
          moneyPHP(r.payment),
        ]),
        {
          header: ["#", "Due date", "Principal", "Interest", "Installment"],
          columnWidths: [
            CONTENT_WIDTH * 0.08,
            CONTENT_WIDTH * 0.22,
            CONTENT_WIDTH * 0.23,
            CONTENT_WIDTH * 0.23,
            CONTENT_WIDTH * 0.24,
          ],
          alignments: ["left", "left", "right", "right", "right"],
        },
      );
      if (input.schedule.length > showRows.length) {
        paragraph(
          doc,
          `First ${showRows.length} of ${input.schedule.length} installments shown. The full schedule is attached and available as a Statement of Account.`,
        );
      }

      section(doc, "Default and Remedies");
      paragraph(
        doc,
        "Failure to pay any installment on its due date shall, at the Lender's option, render the " +
          "entire unpaid balance immediately due and demandable, together with all accrued interest, " +
          "late-payment charges, and any costs of collection. Late charges apply per the Lender's " +
          "published policy.",
      );

      section(doc, "Governing Law and Venue");
      paragraph(
        doc,
        "This Agreement shall be governed by, and construed in accordance with, the laws of the " +
          "Republic of the Philippines. Any action arising hereunder shall be brought in the proper " +
          "courts of Metro Manila, to the exclusion of all other venues.",
      );

      if (input.coMakers && input.coMakers.length > 0) {
        section(doc, "Co-makers / Guarantors");
        for (const cm of input.coMakers) {
          paragraph(
            doc,
            `${cm.fullName} (${cm.role}${cm.relationship ? ", " + cm.relationship : ""}) signs as a co-maker and shall be jointly and severally liable with the Borrower.`,
          );
        }
      }

      section(doc, "Acknowledgment");
      paragraph(
        doc,
        "The Borrower acknowledges having read and understood every provision of this Agreement, " +
          "and agrees to be bound by them.",
      );

      const signers: Parameters<typeof signatureBlock>[1] = [
        {
          label: "Borrower",
          nameHint: fullName,
          signature: input.borrowerSignature,
          signedAt: input.borrowerSignedAt,
        },
        {
          label: "Lender / Authorized Officer",
          nameHint: input.officerName ?? undefined,
          signature: input.officerSignature,
          signedAt: input.officerSignedAt,
        },
      ];
      if (input.coMakers && input.coMakers.length > 0) {
        for (const cm of input.coMakers.slice(0, 2)) {
          signers.push({
            label: cm.role.replace("_", " "),
            nameHint: cm.fullName,
            signature: cm.signature,
            signedAt: cm.signedAt,
          });
        }
      }
      signatureBlock(doc, signers);

      if (input.personnelSignature) {
        personnelStamp(doc, {
          label: "Prepared by",
          ...input.personnelSignature,
        });
      }

      footer(doc, `${input.companyName} · Loan ${input.loan.number}`);
      doc.end();
    } catch (err) {
      // Normalize before rejecting — a thrown non-Error (pdfkit surfaces
      // strings for some stream faults) would otherwise reach callers
      // with no stack, and every call site does `(err as Error).message`.
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
