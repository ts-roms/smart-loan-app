import type {
  KycDocumentType,
  KycSubmission,
  KycSubmissionStatus,
  PrismaClient,
} from '@prisma/client';

export interface KycSubmitInput {
  customerId: string;
  documentType: KycDocumentType;
  documentUrl: string;
  notes?: string;
  submittedById: string;
}

export interface KycDecideInput {
  status: 'VERIFIED' | 'REJECTED';
  reason?: string;
  decidedById: string;
}

/**
 * KYC submissions: documents the customer uploads, decisions the officer
 * makes. Whenever a decision lands we recompute the customer's rollup
 * `kycStatus` so other parts of the system (loan apply) can short-circuit
 * on "incomplete KYC" without re-aggregating every time.
 */
export class KycRepository {
  constructor(private readonly prisma: PrismaClient) {}

  listForCustomer(customerId: string): Promise<KycSubmission[]> {
    return this.prisma.kycSubmission.findMany({
      where: { customerId },
      orderBy: { submittedAt: 'desc' },
    });
  }

  submit(input: KycSubmitInput): Promise<KycSubmission> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.kycSubmission.create({ data: input });
      // Bump rollup to PENDING if it was NONE; verifies still need a manual decide.
      await tx.customer.update({
        where: { id: input.customerId },
        data: { kycStatus: 'PENDING' },
      });
      return row;
    });
  }

  async decide(id: string, input: KycDecideInput): Promise<KycSubmission> {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.kycSubmission.update({
        where: { id },
        data: {
          status: input.status as KycSubmissionStatus,
          reason: input.reason,
          decidedAt: new Date(),
          decidedById: input.decidedById,
        },
      });

      // Recompute the rollup. VERIFIED only if every required doc is verified.
      const REQUIRED: KycDocumentType[] = ['ID_FRONT', 'PROOF_OF_INCOME', 'PROOF_OF_ADDRESS'];
      const all = await tx.kycSubmission.findMany({
        where: { customerId: updated.customerId },
      });
      const byType = new Map(all.map((d) => [d.documentType, d]));
      const everyRequiredVerified = REQUIRED.every(
        (t) => byType.get(t)?.status === 'VERIFIED',
      );
      const anyRejected = all.some((d) => d.status === 'REJECTED');

      const rollup = anyRejected ? 'REJECTED' : everyRequiredVerified ? 'VERIFIED' : 'PENDING';
      await tx.customer.update({
        where: { id: updated.customerId },
        data: { kycStatus: rollup },
      });
      return updated;
    });
  }
}
