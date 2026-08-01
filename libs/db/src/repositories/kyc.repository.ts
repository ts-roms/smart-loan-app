import type {
  KycDocumentType,
  KycSubmission,
  PrismaClient,
} from "@prisma/client";
import { idOrNumberWhere, nextKycNumber } from "../lib/reference-numbers";

export interface KycSubmitInput {
  customerId: string;
  documentType: KycDocumentType;
  documentUrl: string;
  notes?: string;
  submittedById: string;
}

export interface KycDecideInput {
  status: "VERIFIED" | "REJECTED";
  reason?: string;
  decidedById: string;
}

/**
 * Thrown by `KycRepository.submit` when a non-rejected submission of the
 * same `(customerId, documentType)` already exists. The existing record
 * is attached so the caller (typically the HTTP route) can return it in
 * the conflict response and let the UI link to it.
 */
export class KycDuplicateError extends Error {
  readonly code = "KYC_DUPLICATE" as const;
  constructor(readonly existing: KycSubmission) {
    super(
      `A ${existing.status.toLowerCase()} ${existing.documentType} submission already exists.`,
    );
    this.name = "KycDuplicateError";
  }
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
      orderBy: { submittedAt: "desc" },
    });
  }

  /**
   * Submit a KYC document. Inside a transaction so the human reference
   * number allocation can't drift if two submissions race, and so the
   * duplicate check below runs against the same snapshot used for the
   * insert.
   *
   * Dedup rule (FRD §1.5 — "one active document of each type per
   * customer"): if a submission of the same `(customerId, documentType)`
   * already exists in PENDING or VERIFIED state, the call rejects with
   * `KycDuplicateError`. REJECTED documents may be resubmitted — that's
   * the legitimate "operator uploaded the wrong file, here's the right
   * one" flow.
   *
   * The error is structured rather than a plain `Error` so the API route
   * can map it to a 409 with the existing submission's metadata in the
   * response body, letting the UI link the operator to the conflicting
   * record instead of asking them to guess.
   */
  async submit(input: KycSubmitInput): Promise<KycSubmission> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.kycSubmission.findFirst({
        where: {
          customerId: input.customerId,
          documentType: input.documentType,
          status: { in: ["PENDING", "VERIFIED"] },
        },
        orderBy: { submittedAt: "desc" },
      });
      if (existing) {
        throw new KycDuplicateError(existing);
      }

      // Allocate the next "KYC-YYYY-NNNNNN" inside the transaction so the
      // sequence doesn't drift if two submissions race.
      const number = await nextKycNumber(tx as unknown as PrismaClient);
      const row = await tx.kycSubmission.create({ data: { ...input, number } });
      // Bump rollup to PENDING if it was NONE; verifies still need a manual decide.
      await tx.customer.update({
        where: { id: input.customerId },
        data: { kycStatus: "PENDING" },
      });
      return row;
    });
  }

  /**
   * Resolve a KYC submission by either UUID or human number ("KYC-...").
   * Used by routes that take a path id so old UUID links still work.
   */
  findByIdOrNumber(idOrNumber: string): Promise<KycSubmission | null> {
    return this.prisma.kycSubmission.findFirst({
      where: idOrNumberWhere(idOrNumber),
    });
  }

  async decide(id: string, input: KycDecideInput): Promise<KycSubmission> {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.kycSubmission.update({
        where: { id },
        data: {
          status: input.status,
          reason: input.reason,
          decidedAt: new Date(),
          decidedById: input.decidedById,
        },
      });

      // Recompute the rollup. VERIFIED only if every required doc is verified.
      const REQUIRED: KycDocumentType[] = [
        "ID_FRONT",
        "PROOF_OF_INCOME",
        "PROOF_OF_ADDRESS",
      ];
      const all = await tx.kycSubmission.findMany({
        where: { customerId: updated.customerId },
      });
      const byType = new Map(all.map((d) => [d.documentType, d]));
      const everyRequiredVerified = REQUIRED.every(
        (t) => byType.get(t)?.status === "VERIFIED",
      );
      const anyRejected = all.some((d) => d.status === "REJECTED");

      const rollup = anyRejected
        ? "REJECTED"
        : everyRequiredVerified
          ? "VERIFIED"
          : "PENDING";
      await tx.customer.update({
        where: { id: updated.customerId },
        data: { kycStatus: rollup },
      });
      return updated;
    });
  }
}
