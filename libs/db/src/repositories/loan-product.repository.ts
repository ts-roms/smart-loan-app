/**
 * Loan product catalog — fully dynamic. Each row is a product the platform
 * offers; admins can create/edit/deactivate them at runtime.
 *
 * `code` is the stable identifier referenced by LoanApplication.productCode
 * via FK. Once a code is used by a loan, changing it would break history,
 * so we treat code as immutable post-creation.
 */

import { DEFAULT_PRODUCTS } from "@loan/loans";
import type {
  CollateralKind,
  InterestMethod,
  KycDocumentType,
  LoanProduct,
  PaymentFrequency,
  PrismaClient,
} from "@prisma/client";

export interface LoanProductCreateInput {
  code: string;
  name: string;
  description?: string;
  collateralKind?: CollateralKind;
  requiredKycDocs?: KycDocumentType[];
  minPrincipal: number;
  maxPrincipal: number;
  minTermMonths: number;
  maxTermMonths: number;
  defaultRate: number;
  minRate: number;
  maxRate: number;
  maxLoanToValue?: number | null;
  processingFeeRate?: number;
  processingFeeFlat?: number;
  documentaryStampRate?: number;
  lateFeeDailyRate?: number;
  lateFeeCapFraction?: number;
  lateFeeGraceDays?: number;
  preTerminationFeeRate?: number;
  interestMethod?: InterestMethod;
  paymentFrequency?: PaymentFrequency;
  rateByTier?: Record<string, number | null> | null;
  ltvByTier?: Record<string, number> | null;
  active?: boolean;
}

export type LoanProductUpdateInput = Partial<
  Omit<LoanProductCreateInput, "code">
>;

export class LoanProductRepository {
  constructor(private readonly prisma: PrismaClient) {}

  list(): Promise<LoanProduct[]> {
    return this.prisma.loanProduct.findMany({ orderBy: { code: "asc" } });
  }

  findByCode(code: string): Promise<LoanProduct | null> {
    return this.prisma.loanProduct.findUnique({ where: { code } });
  }

  /** Create a brand-new product. Throws on duplicate `code`. */
  create(input: LoanProductCreateInput): Promise<LoanProduct> {
    return this.prisma.loanProduct.create({
      data: {
        code: input.code,
        name: input.name,
        description: input.description ?? null,
        collateralKind: (input.collateralKind ?? "NONE") as never,
        requiredKycDocs: (input.requiredKycDocs ?? []) as never,
        minPrincipal: input.minPrincipal,
        maxPrincipal: input.maxPrincipal,
        minTermMonths: input.minTermMonths,
        maxTermMonths: input.maxTermMonths,
        defaultRate: input.defaultRate,
        minRate: input.minRate,
        maxRate: input.maxRate,
        maxLoanToValue: input.maxLoanToValue ?? null,
        processingFeeRate: input.processingFeeRate ?? 0,
        processingFeeFlat: input.processingFeeFlat ?? 0,
        documentaryStampRate: input.documentaryStampRate ?? 0,
        lateFeeDailyRate: input.lateFeeDailyRate ?? 0.01,
        lateFeeCapFraction: input.lateFeeCapFraction ?? 0.1,
        lateFeeGraceDays: input.lateFeeGraceDays ?? 3,
        preTerminationFeeRate: input.preTerminationFeeRate ?? 0,
        interestMethod: (input.interestMethod ?? "DECLINING") as never,
        paymentFrequency: (input.paymentFrequency ?? "MONTHLY") as never,
        rateByTier: input.rateByTier ?? undefined,
        ltvByTier: input.ltvByTier ?? undefined,
        active: input.active ?? true,
      },
    });
  }

  /** Update by code. Code itself is immutable. */
  update(code: string, input: LoanProductUpdateInput): Promise<LoanProduct> {
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      if (v !== undefined) data[k] = v;
    }
    return this.prisma.loanProduct.update({
      where: { code },
      data: data as never,
    });
  }

  delete(code: string): Promise<LoanProduct> {
    // FK is ON DELETE Restrict — if loans reference this code, this throws.
    return this.prisma.loanProduct.delete({ where: { code } });
  }

  /** Insert defaults if missing; never overwrites existing rows. */
  async seedDefaults(): Promise<{ created: number; existing: number }> {
    let created = 0;
    let existing = 0;
    for (const p of DEFAULT_PRODUCTS) {
      const found = await this.prisma.loanProduct.findUnique({
        where: { code: p.code },
      });
      if (found) {
        existing += 1;
        continue;
      }
      await this.create({
        code: p.code,
        name: p.name,
        description: p.description,
        collateralKind: p.collateralKind,
        requiredKycDocs: p.requiredKycDocs as never,
        minPrincipal: p.minPrincipal,
        maxPrincipal: p.maxPrincipal,
        minTermMonths: p.minTermMonths,
        maxTermMonths: p.maxTermMonths,
        defaultRate: p.defaultRate,
        minRate: p.minRate,
        maxRate: p.maxRate,
        maxLoanToValue: p.maxLoanToValue,
        processingFeeRate: p.processingFeeRate,
        processingFeeFlat: p.processingFeeFlat,
        documentaryStampRate: p.documentaryStampRate,
        lateFeeDailyRate: p.lateFeeDailyRate,
        lateFeeCapFraction: p.lateFeeCapFraction,
        lateFeeGraceDays: p.lateFeeGraceDays,
        preTerminationFeeRate: p.preTerminationFeeRate,
        interestMethod: p.interestMethod,
        paymentFrequency: p.paymentFrequency,
      });
      created += 1;
    }
    return { created, existing };
  }
}
