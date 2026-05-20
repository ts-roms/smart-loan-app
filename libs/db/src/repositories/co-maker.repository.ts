/**
 * Co-maker / co-borrower / guarantor persistence. A loan can have many;
 * the API attaches them at apply time and via post-apply endpoints.
 */
import type { CoMaker, CoMakerRole, GovernmentIdType, PrismaClient } from '@prisma/client';

export interface CoMakerInput {
  fullName: string;
  role?: CoMakerRole;
  relationship?: string;
  phone: string;
  email?: string;
  address?: string;
  governmentIdType?: GovernmentIdType;
  governmentIdNumber?: string;
  monthlyIncome?: number;
  signedAgreementUrl?: string;
  notes?: string;
}

export class CoMakerRepository {
  constructor(private readonly prisma: PrismaClient) {}

  listForLoan(loanId: string): Promise<CoMaker[]> {
    return this.prisma.coMaker.findMany({
      where: { loanId },
      orderBy: { createdAt: 'asc' },
    });
  }

  create(loanId: string, input: CoMakerInput): Promise<CoMaker> {
    return this.prisma.coMaker.create({
      data: {
        loanId,
        fullName: input.fullName,
        role: (input.role ?? 'CO_MAKER') as CoMakerRole,
        relationship: input.relationship,
        phone: input.phone,
        email: input.email,
        address: input.address,
        governmentIdType: input.governmentIdType,
        governmentIdNumber: input.governmentIdNumber,
        monthlyIncome: input.monthlyIncome,
        signedAgreementUrl: input.signedAgreementUrl,
        notes: input.notes,
      },
    });
  }

  update(id: string, input: Partial<CoMakerInput>): Promise<CoMaker> {
    return this.prisma.coMaker.update({ where: { id }, data: input as never });
  }

  delete(id: string): Promise<CoMaker> {
    return this.prisma.coMaker.delete({ where: { id } });
  }
}
