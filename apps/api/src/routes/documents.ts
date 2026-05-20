/**
 * Document streaming routes — agreement, statement of account, receipt.
 *
 * All three are generated on demand from the loan + schedule + payments
 * already in the DB. Nothing is persisted; the PDF is built in memory and
 * piped back as `application/pdf` with a sensible filename.
 *
 * Auth: bearer. Officer scope (these routes) can see any loan; the portal
 * mirrors at `/portal/loans/...` enforce ownership.
 */

import { allocatePayment } from '@loan/accounting';
import { LoanRepository } from '@loan/db';
import { computeFees } from '@loan/loans';
import {
  renderLoanAgreement,
  renderPaymentReceipt,
  renderStatementOfAccount,
} from '@loan/pdf';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const COMPANY_NAME = process.env.COMPANY_NAME ?? 'SmartLoan';
const UPLOADS_DIR = process.env.UPLOADS_DIR ?? join(process.cwd(), 'uploads');

/**
 * Map a stored signature URL (e.g. "/uploads/signatures/xxx.png") to the
 * filesystem path the API serves it from, and read the bytes. Returns null
 * on any failure — the renderer falls back to a blank signature line.
 */
async function loadSignature(url: string | null | undefined): Promise<Buffer | null> {
  if (!url) return null;
  const prefix = '/uploads/';
  if (!url.startsWith(prefix)) return null;
  // Sanitize: strip leading slash, reject .. traversal.
  const rel = url.slice(prefix.length);
  if (rel.includes('..')) return null;
  try {
    return await readFile(join(UPLOADS_DIR, rel));
  } catch {
    return null;
  }
}

function sendPdf(reply: FastifyReply, buf: Buffer, filename: string): FastifyReply {
  return reply
    .header('Content-Type', 'application/pdf')
    .header('Content-Disposition', `inline; filename="${filename}"`)
    .header('Content-Length', String(buf.byteLength))
    .send(buf);
}

/**
 * If `?sign=1` is present, resolve the caller's saved default signature
 * (uploaded once via /auth/me/signature) and return it ready for embedding
 * into a PDF. Returns null when the caller didn't ask, has no saved sig,
 * or the bytes can't be read.
 */
async function resolvePersonnelSignature(
  app: FastifyInstance,
  userId: string,
  signQuery: string | undefined,
): Promise<{ name: string; role?: string; signature: Buffer | null; signedAt: Date | null } | null> {
  if (signQuery !== '1' && signQuery !== 'true') return null;
  const user = await app.prisma.user.findUnique({
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

export async function documentRoutes(app: FastifyInstance) {
  const loans = new LoanRepository(app.prisma);

  app.addHook('preHandler', app.authenticate);

  // ─── Loan agreement ────────────────────────────────────────────────

  app.get<{ Params: { id: string }; Querystring: { sign?: string } }>(
    '/loans/:id/agreement.pdf',
    async (req, reply) => {
      const loan = await loans.findById(req.params.id);
      if (!loan) return reply.code(404).send({ error: 'NotFound' });
      const coMakers = await app.prisma.coMaker.findMany({
        where: { loanId: loan.id },
      });
      const fees = computeFees(Number(loan.principal), {
        processingFeeRate: Number(loan.product.processingFeeRate),
        processingFeeFlat: Number(loan.product.processingFeeFlat),
        documentaryStampRate: Number(loan.product.documentaryStampRate),
      });
      const [borrowerSig, officerSig, coMakerSigs, personnel] = await Promise.all([
        loadSignature(loan.borrowerSignatureUrl),
        loadSignature(loan.officerSignatureUrl),
        Promise.all(coMakers.map((c) => loadSignature(c.signatureUrl))),
        resolvePersonnelSignature(app, req.user.sub, req.query.sign),
      ]);
      let officerName: string | null = null;
      if (loan.officerSignedById) {
        const u = await app.prisma.user.findUnique({
          where: { id: loan.officerSignedById },
          select: { name: true },
        });
        officerName = u?.name ?? null;
      }
      const buf = await renderLoanAgreement({
        companyName: COMPANY_NAME,
        loan: {
          number: loan.number,
          productCode: loan.productCode,
          productName: loan.product.name,
          principal: Number(loan.principal),
          termMonths: loan.termMonths,
          annualInterestRate: Number(loan.annualInterestRate),
          purpose: loan.purpose,
          submittedAt: loan.submittedAt,
          interestMethod: loan.product.interestMethod as 'DECLINING' | 'FLAT',
          paymentFrequency: loan.product.paymentFrequency as 'MONTHLY' | 'BIWEEKLY' | 'WEEKLY',
        },
        customer: {
          firstName: loan.customer.firstName,
          middleName: loan.customer.middleName,
          lastName: loan.customer.lastName,
          address: loan.customer.address,
          city: loan.customer.city,
          governmentIdType: loan.customer.governmentIdType,
          governmentIdNumber: loan.customer.governmentIdNumber,
        },
        fees,
        schedule: loan.schedule.map((s) => ({
          installmentNo: s.installmentNo,
          dueDate: s.dueDate,
          principal: Number(s.principalDue),
          interest: Number(s.interestDue),
          payment: Number(s.totalDue),
        })),
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
      return sendPdf(reply, buf, `agreement-${loan.number}.pdf`);
    },
  );

  // ─── Statement of Account ──────────────────────────────────────────

  app.get<{ Params: { id: string }; Querystring: { sign?: string } }>(
    '/loans/:id/statement.pdf',
    async (req, reply) => {
      const loan = await loans.findById(req.params.id);
      if (!loan) return reply.code(404).send({ error: 'NotFound' });
      const personnel = await resolvePersonnelSignature(
        app,
        req.user.sub,
        req.query.sign,
      );
      const buf = await renderStatementOfAccount({
        companyName: COMPANY_NAME,
        asOf: new Date(),
        loan: {
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
        },
        customer: {
          firstName: loan.customer.firstName,
          middleName: loan.customer.middleName,
          lastName: loan.customer.lastName,
          address: loan.customer.address,
          city: loan.customer.city,
        },
        schedule: loan.schedule.map((s) => ({
          installmentNo: s.installmentNo,
          dueDate: s.dueDate,
          principalDue: Number(s.principalDue),
          interestDue: Number(s.interestDue),
          totalDue: Number(s.totalDue),
          paidInFullAt: s.paidInFullAt,
          principalPaid: Number(s.principalPaid),
        })),
        payments: loan.payments.map((p) => ({
          id: p.id,
          amount: Number(p.amount),
          paidOn: p.paidOn,
          reference: p.reference,
        })),
        personnelSignature: personnel,
      });
      return sendPdf(reply, buf, `statement-${loan.number}.pdf`);
    },
  );

  // ─── Payment receipt ──────────────────────────────────────────────

  app.get<{ Params: { loanId: string; paymentId: string }; Querystring: { sign?: string } }>(
    '/loans/:loanId/payments/:paymentId/receipt.pdf',
    async (req, reply) => {
      const loan = await loans.findById(req.params.loanId);
      if (!loan) return reply.code(404).send({ error: 'NotFound' });
      const payment = loan.payments.find((p) => p.id === req.params.paymentId);
      if (!payment) return reply.code(404).send({ error: 'NotFound' });

      const personnel = await resolvePersonnelSignature(
        app,
        req.user.sub,
        req.query.sign,
      );

      // Re-derive the allocation by replaying allocatePayment against the
      // schedule snapshot we'd have had at payment time. For closed loans
      // this is approximate (since principalPaid is now full); good enough
      // for an OR.
      const openAtTime = loan.schedule
        .filter((s) => !s.paidInFullAt || s.paidInFullAt >= payment.paidOn)
        .map((s) => ({
          interestDue: Number(s.interestDue),
          principalDue: Number(s.principalDue),
        }));
      const allocation = allocatePayment(Number(payment.amount), openAtTime);

      const remainingOutstanding = loan.schedule
        .filter((s) => !s.paidInFullAt)
        .reduce((sum, s) => sum + (Number(s.totalDue) - Number(s.principalPaid)), 0);

      const buf = await renderPaymentReceipt({
        companyName: COMPANY_NAME,
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
      return sendPdf(reply, buf, `receipt-${payment.id.slice(0, 8)}.pdf`);
    },
  );
}

// ─── Portal mirror — same docs, but scoped to the customer's own loans ──

export async function portalDocumentRoutes(app: FastifyInstance) {
  const loans = new LoanRepository(app.prisma);

  app.addHook('preHandler', app.authenticate);

  /**
   * The portal mounts these under /api/v1/portal — auth is already
   * applied by `portalRoutes`; we re-resolve the customer here to make
   * sure the user can only download their own.
   */
  async function ensureOwnership(
    userId: string,
    loanId: string,
  ): Promise<{ ok: true; customerId: string } | { ok: false }> {
    const user = await app.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, customerId: true },
    });
    if (!user || user.role !== 'CUSTOMER' || !user.customerId) return { ok: false };
    const loan = await app.prisma.loanApplication.findUnique({
      where: { id: loanId },
      select: { customerId: true },
    });
    if (!loan || loan.customerId !== user.customerId) return { ok: false };
    return { ok: true, customerId: user.customerId };
  }

  app.get<{ Params: { id: string } }>(
    '/loans/:id/agreement.pdf',
    async (req, reply) => {
      const owns = await ensureOwnership(req.user.sub, req.params.id);
      if (!owns.ok) return reply.code(404).send({ error: 'NotFound' });
      const loan = await loans.findById(req.params.id);
      if (!loan) return reply.code(404).send({ error: 'NotFound' });
      const fees = computeFees(Number(loan.principal), {
        processingFeeRate: Number(loan.product.processingFeeRate),
        processingFeeFlat: Number(loan.product.processingFeeFlat),
        documentaryStampRate: Number(loan.product.documentaryStampRate),
      });
      const [borrowerSig, officerSig] = await Promise.all([
        loadSignature(loan.borrowerSignatureUrl),
        loadSignature(loan.officerSignatureUrl),
      ]);
      const buf = await renderLoanAgreement({
        companyName: COMPANY_NAME,
        loan: {
          number: loan.number,
          productCode: loan.productCode,
          productName: loan.product.name,
          principal: Number(loan.principal),
          termMonths: loan.termMonths,
          annualInterestRate: Number(loan.annualInterestRate),
          purpose: loan.purpose,
          submittedAt: loan.submittedAt,
          interestMethod: loan.product.interestMethod as 'DECLINING' | 'FLAT',
          paymentFrequency: loan.product.paymentFrequency as 'MONTHLY' | 'BIWEEKLY' | 'WEEKLY',
        },
        customer: {
          firstName: loan.customer.firstName,
          middleName: loan.customer.middleName,
          lastName: loan.customer.lastName,
          address: loan.customer.address,
          city: loan.customer.city,
          governmentIdType: loan.customer.governmentIdType,
          governmentIdNumber: loan.customer.governmentIdNumber,
        },
        fees,
        schedule: loan.schedule.map((s) => ({
          installmentNo: s.installmentNo,
          dueDate: s.dueDate,
          principal: Number(s.principalDue),
          interest: Number(s.interestDue),
          payment: Number(s.totalDue),
        })),
        borrowerSignature: borrowerSig,
        borrowerSignedAt: loan.borrowerSignedAt,
        officerSignature: officerSig,
        officerSignedAt: loan.officerSignedAt,
      });
      return sendPdf(reply, buf, `agreement-${loan.number}.pdf`);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/loans/:id/statement.pdf',
    async (req, reply) => {
      const owns = await ensureOwnership(req.user.sub, req.params.id);
      if (!owns.ok) return reply.code(404).send({ error: 'NotFound' });
      const loan = await loans.findById(req.params.id);
      if (!loan) return reply.code(404).send({ error: 'NotFound' });
      const buf = await renderStatementOfAccount({
        companyName: COMPANY_NAME,
        asOf: new Date(),
        loan: {
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
        },
        customer: {
          firstName: loan.customer.firstName,
          middleName: loan.customer.middleName,
          lastName: loan.customer.lastName,
          address: loan.customer.address,
          city: loan.customer.city,
        },
        schedule: loan.schedule.map((s) => ({
          installmentNo: s.installmentNo,
          dueDate: s.dueDate,
          principalDue: Number(s.principalDue),
          interestDue: Number(s.interestDue),
          totalDue: Number(s.totalDue),
          paidInFullAt: s.paidInFullAt,
          principalPaid: Number(s.principalPaid),
        })),
        payments: loan.payments.map((p) => ({
          id: p.id,
          amount: Number(p.amount),
          paidOn: p.paidOn,
          reference: p.reference,
        })),
      });
      return sendPdf(reply, buf, `statement-${loan.number}.pdf`);
    },
  );

  app.get<{ Params: { loanId: string; paymentId: string } }>(
    '/loans/:loanId/payments/:paymentId/receipt.pdf',
    async (req, reply) => {
      const owns = await ensureOwnership(req.user.sub, req.params.loanId);
      if (!owns.ok) return reply.code(404).send({ error: 'NotFound' });
      const loan = await loans.findById(req.params.loanId);
      if (!loan) return reply.code(404).send({ error: 'NotFound' });
      const payment = loan.payments.find((p) => p.id === req.params.paymentId);
      if (!payment) return reply.code(404).send({ error: 'NotFound' });
      const openAtTime = loan.schedule
        .filter((s) => !s.paidInFullAt || s.paidInFullAt >= payment.paidOn)
        .map((s) => ({
          interestDue: Number(s.interestDue),
          principalDue: Number(s.principalDue),
        }));
      const allocation = allocatePayment(Number(payment.amount), openAtTime);
      const remainingOutstanding = loan.schedule
        .filter((s) => !s.paidInFullAt)
        .reduce((sum, s) => sum + (Number(s.totalDue) - Number(s.principalPaid)), 0);
      const buf = await renderPaymentReceipt({
        companyName: COMPANY_NAME,
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
      });
      return sendPdf(reply, buf, `receipt-${payment.id.slice(0, 8)}.pdf`);
    },
  );
}
