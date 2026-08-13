import type {
  KycDocumentType,
  KycSubmission,
  PrismaClient,
} from "@prisma/client";
import { idOrNumberWhere, nextKycNumber } from "../lib/reference-numbers";
import {
  resolvePaging,
  toPage,
  type Page,
  type PageParams,
} from "../lib/pagination";

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
 * True for the error above, across duplicate module copies.
 *
 * Detects by the `code` field rather than `instanceof`: pnpm can
 * resolve two copies of a package, and an `instanceof` spanning them
 * silently returns false — which here would turn a 409 into a 500.
 * Same reasoning as the P2002 checks elsewhere in this package.
 */
export function isKycDuplicate(err: unknown): err is KycDuplicateError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "KYC_DUPLICATE"
  );
}

/**
 * KYC submissions: documents the customer uploads, decisions the officer
 * makes. Whenever a decision lands we recompute the customer's rollup
 * `kycStatus` so other parts of the system (loan apply) can short-circuit
 * on "incomplete KYC" without re-aggregating every time.
 */
/** A row of the review queue — the document plus who it belongs to. */
export interface PendingKycRow {
  id: string;
  number: string;
  customerId: string;
  customerNumber: string;
  customerName: string;
  customerPhone: string;
  documentType: string;
  documentUrl: string;
  status: string;
  submittedAt: string;
}

/** 20 documents is a sitting worth of review without scrolling. */
const KYC_QUEUE_PAGING = { defaultPageSize: 20, maxPageSize: 100 };

export class KycRepository {
  constructor(private readonly prisma: PrismaClient) {}

  listForCustomer(customerId: string): Promise<KycSubmission[]> {
    return this.prisma.kycSubmission.findMany({
      where: { customerId },
      orderBy: { submittedAt: "desc" },
    });
  }

  /**
   * The review queue: documents actually waiting on a decision.
   *
   * Asked for directly, because the officer console had no way to. The
   * only listing endpoint required a `customerId`, so the page fetched
   * the customer pool, filtered it in the browser, and then issued one
   * request PER customer to find out whether they had anything pending
   * — up to two hundred requests to render a queue that is usually
   * three rows.
   *
   * It also asked the wrong question. That filter kept customers whose
   * rollup was NONE, meaning they had submitted nothing at all, so the
   * queue was padded with people who had no documents to review and a
   * wasted round trip each to prove it.
   *
   * Oldest first, deliberately: a review queue is worked front to back,
   * and the document that has been waiting longest is the one that
   * should be looked at next.
   */
  async listPending(params: PageParams = {}): Promise<Page<PendingKycRow>> {
    const paging = resolvePaging(params, KYC_QUEUE_PAGING);
    const where = { status: "PENDING" as const };
    const [rows, total] = await Promise.all([
      this.prisma.kycSubmission.findMany({
        where,
        orderBy: { submittedAt: "asc" },
        skip: paging.skip,
        take: paging.take,
        include: {
          customer: {
            select: {
              id: true,
              number: true,
              firstName: true,
              lastName: true,
              phone: true,
            },
          },
        },
      }),
      this.prisma.kycSubmission.count({ where }),
    ]);
    return toPage(
      rows.map((r) => ({
        id: r.id,
        number: r.number,
        customerId: r.customerId,
        customerNumber: r.customer.number,
        customerName: `${r.customer.firstName} ${r.customer.lastName}`,
        customerPhone: r.customer.phone,
        documentType: r.documentType,
        documentUrl: r.documentUrl,
        status: r.status,
        submittedAt: r.submittedAt.toISOString(),
      })),
      total,
      paging,
    );
  }

  /**
   * Submit a KYC document. Inside a transaction so the human reference
   * number allocation can't drift if two submissions race, and so the
   * duplicate check below runs against the same snapshot used for the
   * insert.
   *
   * Dedup rule ("one active document of each type per
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
