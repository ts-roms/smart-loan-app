/**
 * Co-maker / co-borrower / guarantor persistence. A loan can have many;
 * the API attaches them at apply time and via post-apply endpoints.
 */
import type {
  CoMaker,
  CoMakerConsentStatus,
  CoMakerRole,
  GovernmentIdType,
  KycDocumentType,
  PrismaClient,
} from "@prisma/client";

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
      orderBy: { createdAt: "asc" },
    });
  }

  create(loanId: string, input: CoMakerInput): Promise<CoMaker> {
    return this.prisma.coMaker.create({
      data: {
        loanId,
        fullName: input.fullName,
        role: input.role ?? "CO_MAKER",
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

  // ─── Consent ────────────────────────────────────────────────────

  /** Co-makers with their attachments, for the officer's loan view. */
  listForLoanWithDocuments(loanId: string) {
    return this.prisma.coMaker.findMany({
      where: { loanId },
      orderBy: { createdAt: "asc" },
      include: { documents: { orderBy: { uploadedAt: "asc" } } },
    });
  }

  /**
   * Store a freshly minted invite and reset the response.
   *
   * Re-inviting clears any previous answer along with the old token: a
   * resend means the question is being asked again, and leaving a
   * stale DECLINED on the row would gate disbursement on an answer
   * that no longer applies.
   */
  issueInvite(id: string, token: string, expiresAt: Date): Promise<CoMaker> {
    return this.prisma.coMaker.update({
      where: { id },
      data: {
        inviteToken: token,
        inviteSentAt: new Date(),
        inviteExpiresAt: expiresAt,
        status: "PENDING",
        respondedAt: null,
        declineReason: null,
      },
    });
  }

  /**
   * Resolve an invite token to its co-maker, with everything the
   * consent page needs to explain what's being asked. Returns null for
   * an unknown token — expiry is the caller's to judge, so it can tell
   * "expired" apart from "never existed".
   */
  findByInviteToken(token: string) {
    return this.prisma.coMaker.findUnique({
      where: { inviteToken: token },
      include: {
        documents: { orderBy: { uploadedAt: "asc" } },
        loan: {
          include: {
            customer: {
              select: { firstName: true, lastName: true },
            },
            product: { select: { name: true, requiredKycDocs: true } },
          },
        },
      },
    });
  }

  /** Record the co-maker's answer. */
  respond(
    id: string,
    status: CoMakerConsentStatus,
    declineReason?: string | null,
  ): Promise<CoMaker> {
    return this.prisma.coMaker.update({
      where: { id },
      data: {
        status,
        respondedAt: new Date(),
        declineReason: status === "DECLINED" ? (declineReason ?? null) : null,
      },
    });
  }

  addDocument(input: {
    coMakerId: string;
    documentType: KycDocumentType;
    documentUrl: string;
    notes?: string | null;
  }) {
    return this.prisma.coMakerDocument.create({
      data: {
        coMakerId: input.coMakerId,
        documentType: input.documentType,
        documentUrl: input.documentUrl,
        notes: input.notes ?? null,
      },
    });
  }

  /**
   * Co-makers on this loan who haven't approved. Empty means the
   * consent gate is satisfied — a loan with no co-makers at all
   * trivially passes, which is the common case.
   */
  notApprovedForLoan(loanId: string): Promise<CoMaker[]> {
    return this.prisma.coMaker.findMany({
      where: { loanId, status: { not: "APPROVED" } },
      orderBy: { createdAt: "asc" },
    });
  }
}
