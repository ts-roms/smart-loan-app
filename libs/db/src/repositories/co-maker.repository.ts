/**
 * Co-maker / co-borrower / guarantor persistence. A loan can have many;
 * the API attaches them at apply time and via post-apply endpoints.
 */
import type {
  CoMaker,
  CoMakerConsentStatus,
  CoMakerRole,
  KycDocumentType,
  PrismaClient,
} from "@prisma/client";

/**
 * What the caller supplies. Identity is NOT in here — name, phone,
 * email, address and ID are snapshotted from the Customer row inside
 * `create`, so there is no way for a typed name and a chosen customer
 * to disagree. What's left is what belongs to this particular
 * guarantee rather than to the person.
 */
export interface CoMakerInput {
  customerId: string;
  role?: CoMakerRole;
  relationship?: string;
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

  /**
   * Add a registered customer as co-maker on a loan.
   *
   * The identity fields are read from the Customer row, never from the
   * caller: a co-maker is jointly liable, and letting the officer type
   * a name alongside a customer id is an invitation for the two to
   * disagree — with the typed version being the one that ends up on the
   * agreement.
   *
   * They are still COPIED rather than joined at read time. The invite
   * needs a number to send to at that moment, and the consent record
   * has to name the person who actually agreed; a customer editing
   * their phone next year must not rewrite what a co-maker signed.
   *
   * Three refusals, all of which were unrepresentable while co-makers
   * were free text:
   *   • NotFound      — the customer id doesn't exist
   *   • IsBorrower    — you cannot guarantee your own debt
   *   • AlreadyOnLoan — one person, one guarantee per loan
   */
  async create(
    loanId: string,
    input: CoMakerInput,
  ): Promise<
    | { ok: true; coMaker: CoMaker }
    | {
        ok: false;
        kind: "NotFound" | "IsBorrower" | "AlreadyOnLoan";
        message: string;
      }
  > {
    const [loan, customer] = await Promise.all([
      this.prisma.loanApplication.findUnique({
        where: { id: loanId },
        select: { customerId: true },
      }),
      this.prisma.customer.findUnique({
        where: { id: input.customerId },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          phone: true,
          email: true,
          address: true,
          governmentIdType: true,
          governmentIdNumber: true,
          monthlyIncome: true,
        },
      }),
    ]);
    if (!customer) {
      return { ok: false, kind: "NotFound", message: "Customer not found." };
    }
    if (loan && loan.customerId === customer.id) {
      return {
        ok: false,
        kind: "IsBorrower",
        message:
          "The borrower cannot be their own co-maker — a guarantee has to add someone else's capacity to the loan.",
      };
    }
    const dupe = await this.prisma.coMaker.findFirst({
      where: { loanId, customerId: customer.id },
      select: { id: true },
    });
    if (dupe) {
      return {
        ok: false,
        kind: "AlreadyOnLoan",
        message: "That customer is already a co-maker on this loan.",
      };
    }

    const fullName = `${customer.firstName} ${customer.lastName}`.trim();
    const coMaker = await this.prisma.coMaker.create({
      data: {
        loanId,
        customerId: customer.id,
        fullName,
        role: input.role ?? "CO_MAKER",
        relationship: input.relationship,
        // Snapshot. `phone` is non-null on CoMaker and the invite
        // depends on it, so an empty string is the honest placeholder
        // for a customer with no number on file — the delivery path
        // already reports NoContact rather than pretending to send.
        phone: customer.phone ?? "",
        email: customer.email ?? undefined,
        address: customer.address ?? undefined,
        governmentIdType: customer.governmentIdType ?? undefined,
        governmentIdNumber: customer.governmentIdNumber ?? undefined,
        monthlyIncome: customer.monthlyIncome ?? undefined,
        signedAgreementUrl: input.signedAgreementUrl,
        notes: input.notes,
      },
    });
    return { ok: true, coMaker };
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
        // A resend is a NEW link. Carrying the previous one's open
        // across would tell the officer this link had been delivered
        // when nothing of the sort has happened yet — and the whole
        // reason they resent is usually that it hadn't.
        linkOpenedAt: null,
      },
    });
  }

  /**
   * Record that the consent link was opened.
   *
   * `updateMany` filtered on `linkOpenedAt: null` rather than a read
   * followed by a write: it keeps first-open semantics in a single
   * atomic statement, so two tabs opening at once can't race to
   * overwrite each other, and every call after the first is a no-op
   * that touches no rows.
   *
   * Returns whether this call was the one that recorded it — useful to
   * a caller that wants to log the first open without logging every
   * subsequent page load.
   */
  async markLinkOpened(id: string, at: Date = new Date()): Promise<boolean> {
    const { count } = await this.prisma.coMaker.updateMany({
      where: { id, linkOpenedAt: null },
      data: { linkOpenedAt: at },
    });
    return count > 0;
  }

  /**
   * Kill a co-maker's invite link.
   *
   * The co-maker equivalent of force-logout. They have no account and
   * no session — their entire access to the consent page IS this
   * token — so revoking it is the whole of "cut them off", and unlike
   * a JWT it takes effect on the very next request because every hit
   * on the consent page looks the token up here.
   *
   * `inviteToken: null` rather than a `revoked` flag: the column is
   * uniquely indexed and nullable, so clearing it both frees the value
   * and makes the "unknown token" path the one that already exists.
   * `findByInviteToken` never matches null, so there's no way to bring
   * it back by guessing.
   *
   * The answer they already gave is deliberately left alone. An
   * approval that was validly given is a fact about the loan file, and
   * revoking a link is not the same as retracting a signature — the
   * officer who wants that has decline and delete. Only the way back in
   * is removed.
   */
  revokeInvite(id: string): Promise<CoMaker> {
    return this.prisma.coMaker.update({
      where: { id },
      data: { inviteToken: null, inviteExpiresAt: null },
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
