import { allocatePayment } from "@loan/accounting";
import { type LoanRepository, type PrismaClient } from "@loan/db";
import { computeFees } from "@loan/loans";
import {
  renderLoanAgreement,
  renderPaymentReceipt,
  renderStatementOfAccount,
} from "@loan/pdf";

import { getBranding } from "../../lib/branding";

import { loadSignature } from "./helpers";

/**
 * Document rendering orchestration. The reason this earns a layer:
 *
 *   1. Each endpoint composes 4–6 lookups (loan + co-makers + officer
 *      user + branding + signature bytes) into the PDF renderer's
 *      argument shape. That shape is non-trivial and shared between
 *      the officer + portal mirror.
 *   2. The personnel-signature `?sign=1` resolver is stateful
 *      (filesystem + DB) and used by all three officer endpoints.
 *   3. The portal mirror needs an ownership check before any render.
 *
 * Returns `{ ok: true, buf, filename } | { ok: false, kind: ... }`.
 * The controller maps `NotFound` → 404 and streams `buf` as a PDF.
 */

export interface PdfBundle {
  buf: Buffer;
  filename: string;
}

export type RenderResult =
  | { ok: true; bundle: PdfBundle }
  | { ok: false; kind: "NotFound" };

interface PersonnelSignature {
  name: string;
  role?: string;
  signature: Buffer | null;
  signedAt: Date | null;
}

export class DocumentsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly loans: LoanRepository,
  ) {}

  // ─── officer endpoints ────────────────────────────────────────────

  async agreement(args: {
    idOrNumber: string;
    actorId: string;
    wantsSign: boolean;
  }): Promise<RenderResult> {
    const loan = await this.loans.findByIdOrNumber(args.idOrNumber);
    if (!loan) return { ok: false, kind: "NotFound" };

    const coMakers = await this.prisma.coMaker.findMany({
      where: { loanId: loan.id },
    });
    const fees = computeFees(Number(loan.principal), {
      processingFeeRate: Number(loan.product.processingFeeRate),
      processingFeeFlat: Number(loan.product.processingFeeFlat),
      documentaryStampRate: Number(loan.product.documentaryStampRate),
    });
    const [borrowerSig, officerSig, coMakerSigs, personnel] = await Promise.all(
      [
        loadSignature(loan.borrowerSignatureUrl),
        loadSignature(loan.officerSignatureUrl),
        Promise.all(coMakers.map((c) => loadSignature(c.signatureUrl))),
        this.resolvePersonnelSignature(args.actorId, args.wantsSign),
      ],
    );

    // Officer name lives on the User row, not the loan. Look it up
    // separately so the agreement footer can render "signed by
    // <officer>" alongside the signature image.
    let officerName: string | null = null;
    if (loan.officerSignedById) {
      const u = await this.prisma.user.findUnique({
        where: { id: loan.officerSignedById },
        select: { name: true },
      });
      officerName = u?.name ?? null;
    }

    const branding = await getBranding(this.prisma);
    const buf = await renderLoanAgreement({
      companyName: branding.companyName,
      loan: this.loanShape(loan),
      customer: this.customerShape(loan.customer),
      fees,
      schedule: this.scheduleShape(loan.schedule),
      coMakers: coMakers.map((c, i) => ({
        fullName: c.fullName,
        role: c.role,
        relationship: c.relationship,
        signature: coMakerSigs[i] ?? null,
        signedAt: c.signedAt,
      })),
      borrowerSignature: borrowerSig,
      borrowerSignedAt: loan.borrowerSignedAt,
      officerSignature: officerSig,
      officerSignedAt: loan.officerSignedAt,
      officerName,
      personnelSignature: personnel,
    });
    return {
      ok: true,
      bundle: { buf, filename: `agreement-${loan.number}.pdf` },
    };
  }

  async statement(args: {
    idOrNumber: string;
    actorId: string;
    wantsSign: boolean;
  }): Promise<RenderResult> {
    const loan = await this.loans.findByIdOrNumber(args.idOrNumber);
    if (!loan) return { ok: false, kind: "NotFound" };

    const personnel = await this.resolvePersonnelSignature(
      args.actorId,
      args.wantsSign,
    );
    const branding = await getBranding(this.prisma);
    const buf = await renderStatementOfAccount({
      companyName: branding.companyName,
      asOf: new Date(),
      loan: this.statementLoanShape(loan),
      customer: this.customerStatementShape(loan.customer),
      schedule: this.scheduleStatementShape(loan.schedule),
      payments: this.paymentsShape(loan.payments),
      personnelSignature: personnel,
    });
    return {
      ok: true,
      bundle: { buf, filename: `statement-${loan.number}.pdf` },
    };
  }

  async receipt(args: {
    loanId: string;
    paymentId: string;
    actorId: string;
    wantsSign: boolean;
  }): Promise<RenderResult> {
    const loan = await this.loans.findById(args.loanId);
    if (!loan) return { ok: false, kind: "NotFound" };
    const payment = loan.payments.find((p) => p.id === args.paymentId);
    if (!payment) return { ok: false, kind: "NotFound" };

    const personnel = await this.resolvePersonnelSignature(
      args.actorId,
      args.wantsSign,
    );
    const bundle = await this.buildReceipt(loan, payment, personnel);
    return { ok: true, bundle };
  }

  // ─── portal mirror — ownership-scoped ─────────────────────────────

  async portalAgreement(args: {
    idOrNumber: string;
    customerId: string;
  }): Promise<RenderResult> {
    const loan = await this.loans.findByIdOrNumber(args.idOrNumber);
    if (!loan || loan.customerId !== args.customerId) {
      return { ok: false, kind: "NotFound" };
    }
    const fees = computeFees(Number(loan.principal), {
      processingFeeRate: Number(loan.product.processingFeeRate),
      processingFeeFlat: Number(loan.product.processingFeeFlat),
      documentaryStampRate: Number(loan.product.documentaryStampRate),
    });
    const [borrowerSig, officerSig] = await Promise.all([
      loadSignature(loan.borrowerSignatureUrl),
      loadSignature(loan.officerSignatureUrl),
    ]);
    const branding = await getBranding(this.prisma);
    const buf = await renderLoanAgreement({
      companyName: branding.companyName,
      loan: this.loanShape(loan),
      customer: this.customerShape(loan.customer),
      fees,
      schedule: this.scheduleShape(loan.schedule),
      borrowerSignature: borrowerSig,
      borrowerSignedAt: loan.borrowerSignedAt,
      officerSignature: officerSig,
      officerSignedAt: loan.officerSignedAt,
    });
    return {
      ok: true,
      bundle: { buf, filename: `agreement-${loan.number}.pdf` },
    };
  }

  async portalStatement(args: {
    idOrNumber: string;
    customerId: string;
  }): Promise<RenderResult> {
    const loan = await this.loans.findByIdOrNumber(args.idOrNumber);
    if (!loan || loan.customerId !== args.customerId) {
      return { ok: false, kind: "NotFound" };
    }
    const branding = await getBranding(this.prisma);
    const buf = await renderStatementOfAccount({
      companyName: branding.companyName,
      asOf: new Date(),
      loan: this.statementLoanShape(loan),
      customer: this.customerStatementShape(loan.customer),
      schedule: this.scheduleStatementShape(loan.schedule),
      payments: this.paymentsShape(loan.payments),
    });
    return {
      ok: true,
      bundle: { buf, filename: `statement-${loan.number}.pdf` },
    };
  }

  async portalReceipt(args: {
    loanId: string;
    paymentId: string;
    customerId: string;
  }): Promise<RenderResult> {
    const loan = await this.loans.findById(args.loanId);
    if (!loan || loan.customerId !== args.customerId) {
      return { ok: false, kind: "NotFound" };
    }
    const payment = loan.payments.find((p) => p.id === args.paymentId);
    if (!payment) return { ok: false, kind: "NotFound" };
    const bundle = await this.buildReceipt(loan, payment, null);
    return { ok: true, bundle };
  }

  // ─── internals ────────────────────────────────────────────────────

  /**
   * Resolve the caller's saved default signature for `?sign=1` embeds.
   * Returns null when sign wasn't requested, the user has no saved
   * signature, or the signature bytes can't be read. The renderer
   * treats null as "no personnel signature line."
   */
  private async resolvePersonnelSignature(
    userId: string,
    wantsSign: boolean,
  ): Promise<PersonnelSignature | null> {
    if (!wantsSign) return null;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        name: true,
        role: true,
        defaultSignatureUrl: true,
        signatureSavedAt: true,
      },
    });
    if (!user || !user.defaultSignatureUrl) return null;
    const sig = await loadSignature(user.defaultSignatureUrl);
    return {
      name: user.name,
      role: user.role,
      signature: sig,
      signedAt: user.signatureSavedAt,
    };
  }

  /**
   * Receipt builder shared by officer + portal paths. The OR allocation
   * is re-derived from the schedule snapshot at payment time — for
   * closed loans this is approximate (principalPaid is now full), but
   * good enough for an OR receipt.
   */
  private async buildReceipt(
    loan: Awaited<ReturnType<LoanRepository["findById"]>> extends infer L
      ? Exclude<L, null>
      : never,
    payment: NonNullable<
      Awaited<ReturnType<LoanRepository["findById"]>>
    >["payments"][number],
    personnel: PersonnelSignature | null,
  ): Promise<PdfBundle> {
    const openAtTime = loan.schedule
      .filter((s) => !s.paidInFullAt || s.paidInFullAt >= payment.paidOn)
      .map((s) => ({
        interestDue: Number(s.interestDue),
        principalDue: Number(s.principalDue),
      }));
    const allocation = allocatePayment(Number(payment.amount), openAtTime);
    const remainingOutstanding = loan.schedule
      .filter((s) => !s.paidInFullAt)
      .reduce(
        (sum, s) => sum + (Number(s.totalDue) - Number(s.principalPaid)),
        0,
      );
    const branding = await getBranding(this.prisma);
    const buf = await renderPaymentReceipt({
      companyName: branding.companyName,
      payment: {
        id: payment.id,
        amount: Number(payment.amount),
        paidOn: payment.paidOn,
        reference: payment.reference,
      },
      loan: {
        number: loan.number,
        productCode: loan.productCode,
      },
      customer: {
        firstName: loan.customer.firstName,
        middleName: loan.customer.middleName,
        lastName: loan.customer.lastName,
      },
      allocation: {
        interest: allocation.interest,
        principal: allocation.principal + allocation.overpayment,
      },
      remainingOutstanding,
      personnelSignature: personnel,
    });
    return { buf, filename: `receipt-${payment.id.slice(0, 8)}.pdf` };
  }

  // ─── shape helpers (kept inline because they're shared with portal) ──

  private loanShape(
    loan: NonNullable<Awaited<ReturnType<LoanRepository["findByIdOrNumber"]>>>,
  ) {
    return {
      number: loan.number,
      productCode: loan.productCode,
      productName: loan.product.name,
      principal: Number(loan.principal),
      termMonths: loan.termMonths,
      annualInterestRate: Number(loan.annualInterestRate),
      purpose: loan.purpose,
      submittedAt: loan.submittedAt,
      interestMethod: loan.product.interestMethod as "DECLINING" | "FLAT",
      paymentFrequency: loan.product.paymentFrequency as
        | "MONTHLY"
        | "BIWEEKLY"
        | "WEEKLY",
    };
  }

  private statementLoanShape(
    loan: NonNullable<Awaited<ReturnType<LoanRepository["findByIdOrNumber"]>>>,
  ) {
    return {
      number: loan.number,
      productCode: loan.productCode,
      productName: loan.product.name,
      principal: Number(loan.principal),
      termMonths: loan.termMonths,
      annualInterestRate: Number(loan.annualInterestRate),
      status: loan.status,
      submittedAt: loan.submittedAt,
      disbursedAt: loan.disbursedAt,
      closedAt: loan.closedAt,
    };
  }

  /**
   * Agreement renderer needs the government ID block (it's printed on
   * the signing page). Two shape helpers — one with, one without — so
   * each renderer gets exactly the keys it asks for.
   */
  private customerShape(
    c: NonNullable<
      Awaited<ReturnType<LoanRepository["findByIdOrNumber"]>>
    >["customer"],
  ) {
    return {
      firstName: c.firstName,
      middleName: c.middleName,
      lastName: c.lastName,
      address: c.address,
      city: c.city,
      governmentIdType: c.governmentIdType,
      governmentIdNumber: c.governmentIdNumber,
    };
  }

  /** Statement-flavor customer shape — no gov ID. */
  private customerStatementShape(
    c: NonNullable<
      Awaited<ReturnType<LoanRepository["findByIdOrNumber"]>>
    >["customer"],
  ) {
    return {
      firstName: c.firstName,
      middleName: c.middleName,
      lastName: c.lastName,
      address: c.address,
      city: c.city,
    };
  }

  private scheduleShape(
    schedule: NonNullable<
      Awaited<ReturnType<LoanRepository["findByIdOrNumber"]>>
    >["schedule"],
  ) {
    return schedule.map((s) => ({
      installmentNo: s.installmentNo,
      dueDate: s.dueDate,
      principal: Number(s.principalDue),
      interest: Number(s.interestDue),
      payment: Number(s.totalDue),
    }));
  }

  private scheduleStatementShape(
    schedule: NonNullable<
      Awaited<ReturnType<LoanRepository["findByIdOrNumber"]>>
    >["schedule"],
  ) {
    return schedule.map((s) => ({
      installmentNo: s.installmentNo,
      dueDate: s.dueDate,
      principalDue: Number(s.principalDue),
      interestDue: Number(s.interestDue),
      totalDue: Number(s.totalDue),
      paidInFullAt: s.paidInFullAt,
      principalPaid: Number(s.principalPaid),
    }));
  }

  private paymentsShape(
    payments: NonNullable<
      Awaited<ReturnType<LoanRepository["findByIdOrNumber"]>>
    >["payments"],
  ) {
    return payments.map((p) => ({
      id: p.id,
      amount: Number(p.amount),
      paidOn: p.paidOn,
      reference: p.reference,
    }));
  }
}
