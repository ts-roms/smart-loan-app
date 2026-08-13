/**
 * Loan approval chain repository.
 *
 * Two concerns:
 *
 *   1. **Chain definition** — per LoanProduct, a sequential list of steps
 *      (order, label, requiredPermission). Admins edit these.
 *
 *   2. **Per-loan approval state** — one LoanApproval row per step, created
 *      when the loan is submitted. Each step starts PENDING, transitions to
 *      APPROVED (or REJECTED) when the right person acts.
 *
 * Authority is resolved via `resolveEffectivePermissions` so the existing
 * Delegation feature works out of the box: if the Branch Manager has
 * delegated `loans.approve.bm` to a senior officer during their leave, the
 * senior officer can approve the BM step and the LoanApproval row records
 * which delegation was in effect at the time.
 *
 * Back-compat: when a product has zero steps, the legacy
 * `LoanRepository.decide()` flow still applies — no LoanApproval rows are
 * created, `currentApprovalStep` stays null, and the loan flips directly
 * via the single-decide endpoint.
 */

import {
  declarationsComplete,
  type KycDeclarations,
  type KycDocumentType,
  validateKyc,
} from "@loan/kyc";
import type {
  LoanApproval,
  LoanApprovalStatus,
  LoanApprovalStep,
  Prisma,
  PrismaClient,
} from "@prisma/client";

import { resolveEffectivePermissions } from "./delegation.repository";

type Tx = Prisma.TransactionClient | PrismaClient;

export interface ApprovalStepInput {
  /** 1-indexed; the repo normalises sequential ordering on save. */
  order: number;
  label: string;
  requiredPermission: string;
  optional?: boolean;
}

export interface ApproveStepInput {
  loanId: string;
  approverId: string;
  notes?: string;
  /**
   * Approve the FINAL step despite incomplete KYC documents or
   * unanswered required declarations — the same escape hatch
   * `LoanWorkflowService.decide` offers, and it means the same thing:
   * the whole KYC posture, documents and declarations together.
   *
   * Ignored on non-final steps, which change no loan status and so
   * gate nothing. Every use is recorded in the step's notes.
   */
  overrideKyc?: boolean;
}

/**
 * Refusal by the KYC gate, distinguishable from the other reasons
 * `approveStep` throws so the route can answer 409 — the same code
 * `decide` already answers for the same two refusals — while wrong-state
 * and already-approved errors keep answering 400 as that route
 * documents.
 *
 * Carries a `code` field and is detected by that field rather than by
 * `instanceof`: pnpm can resolve two copies of a library, and an
 * `instanceof` across them silently returns false. Same reasoning as
 * the P2002 checks elsewhere in this package.
 */
export class ApprovalKycBlockedError extends Error {
  readonly code = "APPROVAL_KYC_BLOCKED" as const;
  constructor(
    message: string,
    readonly kind: "KycIncomplete" | "DeclarationsIncomplete",
  ) {
    super(message);
    this.name = "ApprovalKycBlockedError";
  }
}

/** True for the error above, across duplicate module copies. */
export function isApprovalKycBlocked(
  err: unknown,
): err is ApprovalKycBlockedError {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "APPROVAL_KYC_BLOCKED"
  );
}

/**
 * Why the final step re-checks KYC.
 *
 * `decide` validates KYC and declarations before approving, and refuses
 * outright when the chain still has pending steps. That refusal is
 * correct — it closed a hole where one officer holding `loans.decide`
 * could approve past every outstanding sign-off — but it also made the
 * chain the ONLY route to APPROVED for any product that has one. And
 * the chain never checked KYC. So the gate did not become advisory; for
 * chained products it became unreachable, while `decide` still carried
 * the comment saying approval re-checks it.
 *
 * The check lives inside the claim transaction rather than in the route
 * handler so a KYC document rejected between the request arriving and
 * the final signature landing cannot slip through. `decide` checks
 * outside its transaction; that is a weaker guarantee, not one worth
 * copying.
 */
async function kycGate(
  tx: Tx,
  loanId: string,
  overrideKyc: boolean,
): Promise<string[]> {
  const loan = await tx.loanApplication.findUnique({
    where: { id: loanId },
    select: {
      customerId: true,
      kycDeclarations: true,
      product: { select: { requiredKycDocs: true } },
    },
  });
  if (!loan) throw new Error("Loan not found.");

  const notes: string[] = [];

  const submissions = await tx.kycSubmission.findMany({
    where: { customerId: loan.customerId },
    orderBy: { submittedAt: "desc" },
  });
  const extras = (loan.product?.requiredKycDocs ?? []) as KycDocumentType[];
  const kyc = validateKyc(submissions, extras);
  if (!kyc.complete) {
    if (!overrideKyc) {
      throw new ApprovalKycBlockedError(
        `Cannot approve — KYC is ${kyc.status.toLowerCase()}. Missing: ${
          kyc.missing.join(", ") || "none"
        }. Rejected: ${kyc.rejected.join(", ") || "none"}.`,
        "KycIncomplete",
      );
    }
    notes.push(
      `[KYC override: missing=${kyc.missing.join(",") || "none"}, rejected=${
        kyc.rejected.join(",") || "none"
      }]`,
    );
  }

  /*
   * Against the snapshot taken at apply, not the product's current
   * questionnaire — the contract is "answer what you were asked", and
   * an admin adding a required question tomorrow must not retroactively
   * block yesterday's application. Same reasoning as `decide`.
   */
  const decl = declarationsComplete(
    loan.kycDeclarations as KycDeclarations | null,
  );
  if (!decl.complete) {
    if (!overrideKyc) {
      throw new ApprovalKycBlockedError(
        `Cannot approve — ${String(decl.missing.length)} required ` +
          `declaration(s) unanswered: ${decl.missing
            .map((m) => m.label)
            .join(", ")}.`,
        "DeclarationsIncomplete",
      );
    }
    notes.push(
      `[Declarations override: ${String(decl.missing.length)} required unanswered]`,
    );
  }

  return notes;
}

export class LoanApprovalRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // ─── Chain definition (per product) ──────────────────────────────

  /**
   * Give every product a two-step chain if it has none.
   *
   * The chain machinery has existed since the feature landed but no
   * steps were ever configured, so `willUseChain` was always false and
   * every loan was approvable by one person in one call. Seeding turns
   * the feature ON rather than leaving it latent behind an admin screen
   * nobody knew to visit.
   *
   * Officer then manager, using permissions that already exist:
   * `loans.approve.officer` is held by LOAN_OFFICER, `loans.approve.bm`
   * only by ADMIN. So the second signature has to come from someone
   * other than the officer who prepared the file, which is the entire
   * point of a chain.
   *
   * Per product and skip-if-any: an admin who has already tailored a
   * product's chain must not have it overwritten by a reseed, and the
   * seed is expected to run repeatedly.
   */
  async seedDefaultChain(): Promise<{
    productsSeeded: number;
    skipped: number;
  }> {
    const DEFAULT_CHAIN = [
      {
        order: 1,
        label: "Loan officer review",
        requiredPermission: "loans.approve.officer",
      },
      {
        order: 2,
        label: "Branch manager sign-off",
        requiredPermission: "loans.approve.bm",
      },
    ];
    const products = await this.prisma.loanProduct.findMany({
      select: { code: true },
    });
    let productsSeeded = 0;
    let skipped = 0;
    for (const p of products) {
      const existing = await this.prisma.loanApprovalStep.count({
        where: { productCode: p.code },
      });
      if (existing > 0) {
        skipped += 1;
        continue;
      }
      await this.prisma.loanApprovalStep.createMany({
        data: DEFAULT_CHAIN.map((s) => ({ ...s, productCode: p.code })),
      });
      productsSeeded += 1;
    }
    return { productsSeeded, skipped };
  }

  listSteps(productCode: string): Promise<LoanApprovalStep[]> {
    return this.prisma.loanApprovalStep.findMany({
      where: { productCode },
      orderBy: { order: "asc" },
    });
  }

  /**
   * Replace the entire chain in a single transaction. The "delete-all +
   * insert" approach is simpler than per-step diffs and the cost is
   * trivial (typically 2-5 rows per product).
   *
   * Normalises orders to 1, 2, 3… regardless of what the caller passed
   * so the chain is always contiguous.
   */
  async saveSteps(
    productCode: string,
    steps: ApprovalStepInput[],
  ): Promise<LoanApprovalStep[]> {
    return this.prisma.$transaction(async (tx) => {
      await tx.loanApprovalStep.deleteMany({ where: { productCode } });
      if (steps.length === 0) return [];
      // Sort by the input `order` first so the caller's intent is
      // preserved even when they don't pass perfectly-1-indexed values.
      const sorted = [...steps].sort((a, b) => a.order - b.order);
      const created: LoanApprovalStep[] = [];
      for (let i = 0; i < sorted.length; i++) {
        const row = sorted[i]!;
        const next = await tx.loanApprovalStep.create({
          data: {
            productCode,
            order: i + 1,
            label: row.label,
            requiredPermission: row.requiredPermission,
            optional: row.optional ?? false,
          },
        });
        created.push(next);
      }
      return created;
    });
  }

  // ─── Per-loan rows ───────────────────────────────────────────────

  /**
   * Snapshot the product's chain onto a freshly-submitted loan. Called by
   * LoanRepository.apply() inside its transaction. Returns the count of
   * pending steps so the caller can set currentApprovalStep appropriately:
   *   • 0 → product has no chain; leave currentApprovalStep null
   *   • N → set currentApprovalStep = 1 (first step is awaiting)
   */
  async createPendingApprovals(
    tx: Tx,
    loanId: string,
    productCode: string,
  ): Promise<number> {
    const steps = await tx.loanApprovalStep.findMany({
      where: { productCode },
      orderBy: { order: "asc" },
    });
    if (steps.length === 0) return 0;
    for (const step of steps) {
      await tx.loanApproval.create({
        data: {
          loanId,
          stepOrder: step.order,
          stepLabel: step.label,
          requiredPermission: step.requiredPermission,
          status: "PENDING" satisfies LoanApprovalStatus,
        },
      });
    }
    return steps.length;
  }

  /**
   * Return the list of active users currently authorized to act on a step
   * with the given permission key. Used by the notification dispatcher to
   * compute the recipient list when a step opens.
   *
   * "Authorized" = the user holds the permission either directly via a
   * role they're assigned to, or transitively via an active Delegation
   * whose `permissions` list includes the key (or is empty, meaning
   * "all of the delegator's permissions"). Inactive users are excluded.
   *
   * Deduped by user id. We do NOT page — the result set is small
   * (typically <20 staff per permission) and the caller wants the full
   * list to broadcast.
   */
  async findApproversForPermission(
    permission: string,
    now: Date = new Date(),
  ): Promise<Array<{ id: string; name: string; email: string }>> {
    // Pull all role-permission rows for this key, follow to users.
    const directRows = await this.prisma.userRoleAssignment.findMany({
      where: {
        user: { active: true },
        role: {
          permissions: { some: { permission: { key: permission } } },
        },
      },
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
    });

    // Plus anyone holding the permission via an active delegation. We
    // check both shapes: explicit permission key in the delegation's list,
    // OR an empty list (which means "all of the delegator's permissions"
    // — we further constrain to delegators who actually hold the key).
    const delegationRows = await this.prisma.delegation.findMany({
      where: {
        revokedAt: null,
        startsAt: { lte: now },
        endsAt: { gte: now },
        delegate: { active: true },
        OR: [
          { permissions: { has: permission } },
          {
            // Blanket delegation — only counts if delegator currently
            // holds the key. Cheap to filter inside the JS layer below
            // since blanket delegations are rare.
            permissions: { isEmpty: true },
          },
        ],
      },
      include: {
        delegate: { select: { id: true, name: true, email: true } },
        delegator: {
          select: {
            id: true,
            roleAssignments: {
              select: {
                role: {
                  select: {
                    permissions: {
                      select: { permission: { select: { key: true } } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const map = new Map<string, { id: string; name: string; email: string }>();
    for (const row of directRows) {
      const u = row.user;
      map.set(u.id, u);
    }
    for (const d of delegationRows) {
      // For blanket delegations, double-check the delegator actually has
      // the permission. Without this, revoking the role from the
      // delegator would silently leak the permission to the delegate.
      if (d.permissions.length === 0) {
        const delegatorKeys = new Set<string>();
        for (const ra of d.delegator.roleAssignments) {
          for (const rp of ra.role.permissions) {
            delegatorKeys.add(rp.permission.key);
          }
        }
        if (!delegatorKeys.has(permission)) continue;
      }
      map.set(d.delegate.id, d.delegate);
    }
    return [...map.values()];
  }

  /** All approval rows for a loan, ordered by step. */
  /**
   * Steps still awaiting a decision on this loan.
   *
   * Exists so the single-shot `decide` endpoint can refuse to approve
   * past a chain that hasn't finished. Returns the labels rather than a
   * bare count, because the officer being refused needs to be told what
   * is still outstanding and who it's waiting on — "cannot approve" with
   * no explanation just looks broken.
   *
   * Zero rows is the normal case for a product with no chain, and the
   * caller must treat that as "nothing blocking" rather than an error.
   */
  async pendingSteps(
    loanId: string,
  ): Promise<
    Array<{ stepOrder: number; stepLabel: string; requiredPermission: string }>
  > {
    return this.prisma.loanApproval.findMany({
      where: { loanId, status: "PENDING" },
      orderBy: { stepOrder: "asc" },
      select: { stepOrder: true, stepLabel: true, requiredPermission: true },
    });
  }

  listForLoan(loanId: string): Promise<
    Array<
      LoanApproval & {
        approver: { id: string; name: string; email: string } | null;
      }
    >
  > {
    return this.prisma.loanApproval.findMany({
      where: { loanId },
      orderBy: { stepOrder: "asc" },
      include: {
        approver: { select: { id: true, name: true, email: true } },
      },
    });
  }

  /**
   * Approve the loan's current pending step on behalf of `approverId`.
   *
   * Atomicity matters here:
   *   1. Re-check we have the right permission inside the tx (so a
   *      concurrent role revoke can't sneak through).
   *   2. Update the approval row.
   *   3. If more steps remain, bump currentApprovalStep.
   *   4. If this was the last step, set loan.status=APPROVED + decidedAt.
   *
   * Throws on any failure so the caller can map to the right HTTP code.
   */
  async approveStep(input: ApproveStepInput): Promise<{
    approval: LoanApproval;
    isFinal: boolean;
    nextStep: number | null;
  }> {
    return this.prisma.$transaction(async (tx) => {
      const loan = await tx.loanApplication.findUnique({
        where: { id: input.loanId },
        select: { id: true, status: true, currentApprovalStep: true },
      });
      if (!loan) throw new Error("Loan not found.");
      if (loan.currentApprovalStep == null) {
        throw new Error("This loan is not under an approval chain.");
      }
      const pending = await tx.loanApproval.findUnique({
        where: {
          loanId_stepOrder: {
            loanId: input.loanId,
            stepOrder: loan.currentApprovalStep,
          },
        },
      });
      if (!pending) throw new Error("Pending approval row missing.");
      if (pending.status !== "PENDING") {
        throw new Error(
          `Step ${pending.stepOrder} is already ${pending.status.toLowerCase()}.`,
        );
      }

      // Re-resolve permissions inside the tx so a role revoke that landed
      // since the HTTP handler started can't slip through.
      const { permissions, viaDelegations } = await resolveEffectivePermissions(
        tx as unknown as PrismaClient,
        input.approverId,
      );
      if (!permissions.has(pending.requiredPermission)) {
        throw new Error(
          `You don't hold the required permission (${pending.requiredPermission}) for this step.`,
        );
      }
      // If the user got the perm via Delegation, record which one — the
      // approval row tracks "approved as stand-in" so audits read clearly.
      const usedDelegation = viaDelegations.find(
        (d) =>
          d.permissions.length === 0 ||
          d.permissions.includes(pending.requiredPermission),
      );

      /*
       * Is there a next step? Asked BEFORE the row is written, because
       * the answer decides whether this signature approves the loan —
       * and if it does, the KYC gate below may refuse it. Writing the
       * approval first would leave a step marked APPROVED by someone
       * whose approval was then rejected. The query does not depend on
       * this row's status, so moving it earlier changes nothing else.
       */
      const next = await tx.loanApproval.findFirst({
        where: {
          loanId: input.loanId,
          stepOrder: { gt: loan.currentApprovalStep },
          status: "PENDING",
        },
        orderBy: { stepOrder: "asc" },
      });

      // The final signature is the one that approves the loan, so it is
      // the one that has to satisfy what approval requires.
      const gateNotes = next
        ? []
        : await kycGate(tx, input.loanId, input.overrideKyc ?? false);

      const updated = await tx.loanApproval.update({
        where: { id: pending.id },
        data: {
          status: "APPROVED" satisfies LoanApprovalStatus,
          approverId: input.approverId,
          approvedAt: new Date(),
          notes: [input.notes, ...gateNotes].filter(Boolean).join(" ") || null,
          signedUnderDelegationId: usedDelegation?.id ?? null,
        },
      });

      if (next) {
        await tx.loanApplication.update({
          where: { id: input.loanId },
          data: { currentApprovalStep: next.stepOrder },
        });
        return { approval: updated, isFinal: false, nextStep: next.stepOrder };
      }

      // Final step — flip the loan to APPROVED.
      await tx.loanApplication.update({
        where: { id: input.loanId },
        data: {
          status: "APPROVED",
          decidedById: input.approverId,
          decidedAt: new Date(),
          currentApprovalStep: null,
        },
      });
      return { approval: updated, isFinal: true, nextStep: null };
    });
  }

  /**
   * Reject the current pending step. Rejection is terminal — the loan
   * flips to REJECTED, no further steps can be approved. Notes are
   * required for rejection (vs optional for approval) because audits
   * always want the reason.
   */
  async rejectStep(
    input: ApproveStepInput & { notes: string },
  ): Promise<LoanApproval> {
    return this.prisma.$transaction(async (tx) => {
      const loan = await tx.loanApplication.findUnique({
        where: { id: input.loanId },
        select: { id: true, status: true, currentApprovalStep: true },
      });
      if (!loan) throw new Error("Loan not found.");
      if (loan.currentApprovalStep == null) {
        throw new Error("This loan is not under an approval chain.");
      }
      const pending = await tx.loanApproval.findUnique({
        where: {
          loanId_stepOrder: {
            loanId: input.loanId,
            stepOrder: loan.currentApprovalStep,
          },
        },
      });
      if (!pending) throw new Error("Pending approval row missing.");
      if (pending.status !== "PENDING") {
        throw new Error(
          `Step ${pending.stepOrder} is already ${pending.status.toLowerCase()}.`,
        );
      }
      const { permissions, viaDelegations } = await resolveEffectivePermissions(
        tx as unknown as PrismaClient,
        input.approverId,
      );
      if (!permissions.has(pending.requiredPermission)) {
        throw new Error(
          `You don't hold the required permission (${pending.requiredPermission}) for this step.`,
        );
      }
      const usedDelegation = viaDelegations.find(
        (d) =>
          d.permissions.length === 0 ||
          d.permissions.includes(pending.requiredPermission),
      );
      const updated = await tx.loanApproval.update({
        where: { id: pending.id },
        data: {
          status: "REJECTED" satisfies LoanApprovalStatus,
          approverId: input.approverId,
          approvedAt: new Date(),
          notes: input.notes,
          signedUnderDelegationId: usedDelegation?.id ?? null,
        },
      });
      await tx.loanApplication.update({
        where: { id: input.loanId },
        data: {
          status: "REJECTED",
          decisionReason: input.notes,
          decidedById: input.approverId,
          decidedAt: new Date(),
          currentApprovalStep: null,
        },
      });
      return updated;
    });
  }
}
