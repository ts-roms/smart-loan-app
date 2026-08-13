import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";

import {
  isApprovalKycBlocked,
  LoanApprovalRepository,
} from "./loan-approval.repository";

/**
 * Invariant: nothing reaches APPROVED with an incomplete KYC file.
 *
 * Two paths lead to APPROVED and only one of them checked. `decide`
 * validates KYC documents and required declarations before approving —
 * and, since the chain was enforced, refuses outright when approval
 * steps are still pending. That refusal was right on its own terms, but
 * it made the chain the ONLY route to APPROVED for any product that has
 * one, and `approveStep` flipped the loan on the final signature
 * without looking at KYC at all.
 *
 * So the gate did not degrade to advisory. For chained products it
 * became unreachable: `decide` would not approve them, and the path
 * that would never asked. Every seeded product has a chain, which makes
 * the unchecked path the ordinary one rather than an edge case.
 *
 * The fake models what matters: KYC submissions and the declarations
 * snapshot are read from the same store the gate consults, and the loan
 * only reaches APPROVED through a real final-step call.
 */

interface State {
  loanStatus: string;
  currentStep: number | null;
  steps: {
    stepOrder: number;
    status: string;
    requiredPermission: string;
    notes?: string | null;
  }[];
  submissions: { documentType: string; status: string }[];
  declarations: unknown;
}

/**
 * A KYC pack `validateKyc` accepts as complete: REQUIRED_DOCS, every
 * one VERIFIED. Anything less is what the gate is for.
 */
const COMPLETE_KYC = [
  { documentType: "ID_FRONT", status: "VERIFIED" },
  { documentType: "PROOF_OF_INCOME", status: "VERIFIED" },
  { documentType: "PROOF_OF_ADDRESS", status: "VERIFIED" },
];

/** A declarations snapshot with every required question answered. */
const COMPLETE_DECLARATIONS = {
  items: [
    { id: "q1", label: "Any other loans?", required: true, answer: "false" },
  ],
};

const UNANSWERED_DECLARATIONS = {
  items: [
    { id: "q1", label: "Any other loans?", required: true, answer: null },
  ],
};

function fakePrisma(state: State) {
  const client = {
    $transaction: <T>(fn: (tx: unknown) => Promise<T>) => fn(client),
    loanApplication: {
      findUnique: ({ select }: { select?: Record<string, unknown> }) => {
        // The gate's read asks for customerId + declarations + product;
        // approveStep's own read asks for status + currentApprovalStep.
        if (select && "kycDeclarations" in select) {
          return Promise.resolve({
            customerId: "c1",
            kycDeclarations: state.declarations,
            product: { requiredKycDocs: [] },
          });
        }
        return Promise.resolve({
          id: "L1",
          status: state.loanStatus,
          currentApprovalStep: state.currentStep,
        });
      },
      update: ({ data }: { data: { status?: string } }) => {
        if (data.status) state.loanStatus = data.status;
        if ("currentApprovalStep" in data) {
          state.currentStep = (
            data as { currentApprovalStep: number | null }
          ).currentApprovalStep;
        }
        return Promise.resolve({});
      },
    },
    loanApproval: {
      findUnique: ({
        where,
      }: {
        where: { loanId_stepOrder: { stepOrder: number } };
      }) => {
        const s = state.steps.find(
          (x) => x.stepOrder === where.loanId_stepOrder.stepOrder,
        );
        return Promise.resolve(
          s ? { id: `a${String(s.stepOrder)}`, ...s } : null,
        );
      },
      findFirst: ({
        where,
      }: {
        where: { stepOrder: { gt: number }; status: string };
      }) =>
        Promise.resolve(
          state.steps.find(
            (s) => s.stepOrder > where.stepOrder.gt && s.status === "PENDING",
          ) ?? null,
        ),
      update: ({
        where,
        data,
      }: {
        where: { id: string };
        data: { status: string; notes?: string | null };
      }) => {
        const s = state.steps.find(
          (x) => `a${String(x.stepOrder)}` === where.id,
        )!;
        s.status = data.status;
        s.notes = data.notes ?? null;
        return Promise.resolve({ id: where.id, ...s });
      },
    },
    kycSubmission: {
      findMany: () => Promise.resolve(state.submissions),
    },
    /*
     * Permission resolution has its own tests; here it just has to say
     * yes, so a failure in this file can only mean the KYC gate. The
     * assignment carries both step permissions so neither step is
     * refused for the wrong reason.
     */
    userRoleAssignment: {
      findMany: () => Promise.resolve([{ roleId: "r1" }]),
    },
    roleInheritance: { findMany: () => Promise.resolve([]) },
    rolePermission: {
      findMany: () =>
        Promise.resolve([
          {
            permission: { key: "loans.approve.officer", status: "ACTIVE" },
          },
          { permission: { key: "loans.approve.bm", status: "ACTIVE" } },
        ]),
    },
    delegation: { findMany: () => Promise.resolve([]) },
  };
  return client as unknown as PrismaClient;
}

function repoFor(state: State) {
  return new LoanApprovalRepository(fakePrisma(state));
}

function baseState(overrides: Partial<State> = {}): State {
  return {
    loanStatus: "SUBMITTED",
    currentStep: 2,
    steps: [
      {
        stepOrder: 1,
        status: "APPROVED",
        requiredPermission: "loans.approve.officer",
      },
      {
        stepOrder: 2,
        status: "PENDING",
        requiredPermission: "loans.approve.bm",
      },
    ],
    submissions: COMPLETE_KYC,
    declarations: COMPLETE_DECLARATIONS,
    ...overrides,
  };
}

let state: State;

beforeEach(() => {
  state = baseState();
});

describe("the final approval step re-checks KYC", () => {
  it("approves when documents and declarations are both complete", async () => {
    const repo = repoFor(state);

    const result = await repo.approveStep({
      loanId: "L1",
      approverId: "u1",
    });

    expect(result.isFinal).toBe(true);
    expect(state.loanStatus).toBe("APPROVED");
  });

  it("refuses the final step when required declarations are unanswered", async () => {
    state.declarations = UNANSWERED_DECLARATIONS;
    const repo = repoFor(state);

    await expect(
      repo.approveStep({ loanId: "L1", approverId: "u1" }),
    ).rejects.toThrow(/declaration\(s\) unanswered/);

    // The loan did NOT approve, and the step was not consumed — a
    // refused signature must leave the chain exactly where it was.
    expect(state.loanStatus).toBe("SUBMITTED");
    expect(state.steps[1]!.status).toBe("PENDING");
  });

  it("carries the kind so the route can answer 409, not 400", async () => {
    state.declarations = UNANSWERED_DECLARATIONS;
    const repo = repoFor(state);

    const err: unknown = await repo
      .approveStep({ loanId: "L1", approverId: "u1" })
      .catch((e: unknown) => e);

    expect(isApprovalKycBlocked(err)).toBe(true);
    expect(isApprovalKycBlocked(err) ? err.kind : null).toBe(
      "DeclarationsIncomplete",
    );
  });

  it("lets an explicit override through, and records it in the notes", async () => {
    state.declarations = UNANSWERED_DECLARATIONS;
    const repo = repoFor(state);

    await repo.approveStep({
      loanId: "L1",
      approverId: "u1",
      notes: "Manager accepted the risk.",
      overrideKyc: true,
    });

    expect(state.loanStatus).toBe("APPROVED");
    // The override is not silent — an audit reading the step sees it.
    expect(state.steps[1]!.notes).toContain("Manager accepted the risk.");
    expect(state.steps[1]!.notes).toContain("Declarations override");
  });

  it("does not gate a NON-final step, which approves nothing", async () => {
    /*
     * The gate belongs on the signature that flips the loan. Blocking
     * step 1 would stop an officer from doing their own review while
     * the file is still being assembled — the ordinary case, since KYC
     * is often completed between the first and last sign-off.
     */
    state.currentStep = 1;
    state.steps[0]!.status = "PENDING";
    state.declarations = UNANSWERED_DECLARATIONS;
    const repo = repoFor(state);

    const result = await repo.approveStep({ loanId: "L1", approverId: "u1" });

    expect(result.isFinal).toBe(false);
    expect(result.nextStep).toBe(2);
    expect(state.loanStatus).toBe("SUBMITTED");
  });

  it("refuses the final step when KYC documents are missing", async () => {
    state.submissions = [];
    const repo = repoFor(state);

    await expect(
      repo.approveStep({ loanId: "L1", approverId: "u1" }),
    ).rejects.toThrow(/KYC is/);

    expect(state.loanStatus).toBe("SUBMITTED");
  });
});
