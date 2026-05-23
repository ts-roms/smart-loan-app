/**
 * Compliance service — gating tests.
 *
 * Scope is the safety gates that matter for compliance:
 *
 *   1. `eraseCustomer` refuses without `acknowledgesRetention: true`
 *      (auditor-grade double confirmation).
 *   2. `eraseCustomer` refuses to double-erase (would lose the
 *      original erasedAt timestamp).
 *   3. `exportCustomer` writes an audit row for every export — the
 *      DSAR trail itself is auditable.
 *
 * The actual data-walking + redaction logic is exercised end-to-end
 * by the runbook (R7 — see docs/runbooks.md once written). These
 * unit tests just protect the gates.
 */

import { describe, expect, it, vi } from "vitest";

import { ComplianceService } from "./compliance.service";

function makePrisma(opts: {
  customer?: { id: string; erasedAt?: Date | null } | null;
}) {
  const update = vi.fn(async () => ({}));
  const userUpdateMany = vi.fn(async () => ({ count: 0 }));
  return {
    customer: {
      findUnique: vi.fn(async () => opts.customer ?? null),
      update,
    },
    user: { updateMany: userUpdateMany },
    // Every relation read returns [] so the export test runs against
    // an "empty-but-existing" customer. We're not testing what's
    // returned; we're testing that the gate before the read held.
    kycSubmission: { findMany: vi.fn(async () => []) },
    loanApplication: { findMany: vi.fn(async () => []) },
    loanSchedule: { findMany: vi.fn(async () => []) },
    loanPayment: { findMany: vi.fn(async () => []) },
    auditEvent: { findMany: vi.fn(async () => []) },
    contribution: { findMany: vi.fn(async () => []) },
    savingsTransaction: { findMany: vi.fn(async () => []) },
    amlScreening: { findMany: vi.fn(async () => []) },
    surveyResponse: { findMany: vi.fn(async () => []) },
    creditScore: { findMany: vi.fn(async () => []) },
    notification: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (ops: unknown[]) => {
      // Execute each op — they're already promises in Prisma's
      // sequential transaction form.
      const results = [];
      for (const op of ops) results.push(await op);
      return results;
    }),
    _customerUpdate: update,
    _userUpdateMany: userUpdateMany,
  };
}

type AuditCall = {
  action: string;
  actorId: string;
  targetType?: string;
  targetId?: string;
  payload?: unknown;
};

function makeAudit() {
  return {
    record: vi.fn(async (_input: AuditCall) => ({ id: "audit-1" })),
  };
}

const CUSTOMER_ID = "11111111-2222-3333-4444-555555555555";
const ACTOR_ID = "actor-1";

describe("ComplianceService", () => {
  describe("eraseCustomer — gates", () => {
    it("refuses without acknowledgesRetention", async () => {
      const prisma = makePrisma({ customer: { id: CUSTOMER_ID } });
      const audit = makeAudit();
      const svc = new ComplianceService(prisma as never, audit as never);

      const result = await svc.eraseCustomer({
        customerId: CUSTOMER_ID,
        actorId: ACTOR_ID,
        reason: "DSAR ticket #1234",
        acknowledgesRetention: false,
      });
      expect(result.ok).toBe(false);
      expect((result as { kind: string }).kind).toBe("AcknowledgmentRequired");
      // Critical: nothing was written. The transaction never ran.
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it("returns NotFound on a missing customer", async () => {
      const prisma = makePrisma({ customer: null });
      const audit = makeAudit();
      const svc = new ComplianceService(prisma as never, audit as never);

      const result = await svc.eraseCustomer({
        customerId: CUSTOMER_ID,
        actorId: ACTOR_ID,
        reason: "DSAR ticket #1234",
        acknowledgesRetention: true,
      });
      expect(result.ok).toBe(false);
      expect((result as { kind: string }).kind).toBe("NotFound");
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("refuses to double-erase", async () => {
      const prisma = makePrisma({
        customer: { id: CUSTOMER_ID, erasedAt: new Date("2026-01-01") },
      });
      const audit = makeAudit();
      const svc = new ComplianceService(prisma as never, audit as never);

      const result = await svc.eraseCustomer({
        customerId: CUSTOMER_ID,
        actorId: ACTOR_ID,
        reason: "duplicate request",
        acknowledgesRetention: true,
      });
      expect(result.ok).toBe(false);
      expect((result as { kind: string }).kind).toBe("AlreadyErased");
      // Critical: the original erasedAt isn't overwritten.
      expect(prisma._customerUpdate).not.toHaveBeenCalled();
    });

    it("erases when gates pass and records the audit row", async () => {
      const prisma = makePrisma({
        customer: { id: CUSTOMER_ID, erasedAt: null },
      });
      const audit = makeAudit();
      const svc = new ComplianceService(prisma as never, audit as never);

      const result = await svc.eraseCustomer({
        customerId: CUSTOMER_ID,
        actorId: ACTOR_ID,
        reason: "DSAR ticket #1234 — borrower closed account",
        acknowledgesRetention: true,
      });
      expect(result.ok).toBe(true);
      // Update transaction + portal-login deactivation both fired.
      expect(prisma._customerUpdate).toHaveBeenCalledTimes(1);
      expect(prisma._userUpdateMany).toHaveBeenCalledTimes(1);
      // Audit row carries the reason + cleared fields.
      expect(audit.record).toHaveBeenCalledTimes(1);
      const call = audit.record.mock.calls[0]![0] as unknown as {
        action: string;
        payload: { reason: string; fieldsCleared: string[] };
      };
      expect(call.action).toBe("CUSTOMER_ERASE");
      expect(call.payload.reason).toBe(
        "DSAR ticket #1234 — borrower closed account",
      );
      expect(call.payload.fieldsCleared).toContain("firstName");
      expect(call.payload.fieldsCleared).toContain("governmentIdNumber");
    });
  });

  describe("exportCustomer — audit", () => {
    it("returns NotFound on a missing customer (no audit row)", async () => {
      const prisma = makePrisma({ customer: null });
      const audit = makeAudit();
      const svc = new ComplianceService(prisma as never, audit as never);

      const result = await svc.exportCustomer({
        customerId: CUSTOMER_ID,
        actorId: ACTOR_ID,
      });
      expect(result.ok).toBe(false);
      // Not-found exports are NOT logged — they're a permission-
      // check failure shape, not a privacy-relevant action.
      expect(audit.record).not.toHaveBeenCalled();
    });

    it("writes an audit row for every successful export", async () => {
      const prisma = makePrisma({ customer: { id: CUSTOMER_ID } });
      const audit = makeAudit();
      const svc = new ComplianceService(prisma as never, audit as never);

      const result = await svc.exportCustomer({
        customerId: CUSTOMER_ID,
        actorId: ACTOR_ID,
        reason: "DSAR ticket #5678",
      });
      expect(result.ok).toBe(true);
      expect(audit.record).toHaveBeenCalledTimes(1);
      const call = audit.record.mock.calls[0]![0] as unknown as {
        action: string;
        payload: { reason: string | null; rowCounts: object };
      };
      expect(call.action).toBe("CUSTOMER_DATA_EXPORT");
      expect(call.payload.reason).toBe("DSAR ticket #5678");
      // rowCounts captures the size of each section — useful for
      // compliance to verify the export matched what was sent.
      expect(call.payload.rowCounts).toMatchObject({
        kycSubmissions: 0,
        loanApplications: 0,
        auditEvents: 0,
      });
    });

    it("audits with reason=null when none is supplied", async () => {
      const prisma = makePrisma({ customer: { id: CUSTOMER_ID } });
      const audit = makeAudit();
      const svc = new ComplianceService(prisma as never, audit as never);

      await svc.exportCustomer({
        customerId: CUSTOMER_ID,
        actorId: ACTOR_ID,
      });
      const call = audit.record.mock.calls[0]![0] as unknown as {
        payload: { reason: string | null };
      };
      expect(call.payload.reason).toBeNull();
    });
  });
});
