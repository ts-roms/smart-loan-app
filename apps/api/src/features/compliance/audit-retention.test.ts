/**
 * The audit carve-out's classification rules.
 *
 * The property that matters most here is the DEFAULT. An unknown action
 * must classify as preserved, because the alternative — defaulting to
 * disposable — means the day someone adds a money-path audit event and
 * forgets this file, the nightly job starts deleting financial records
 * silently and unrecoverably.
 */

import { describe, expect, it } from "vitest";

import {
  classifyAuditAction,
  isPurgeableAuditAction,
  purgeableAuditWhere,
  FINANCIAL_AUDIT_ACTIONS,
  OPERATIONAL_AUDIT_ACTIONS,
  PRIVACY_AUDIT_ACTIONS,
  SECURITY_AUDIT_ACTIONS,
} from "./audit-retention";

describe("classifyAuditAction", () => {
  it("labels the four preserved families", () => {
    expect(classifyAuditAction("LOAN_APPROVAL_STEP")).toBe("FINANCIAL");
    expect(classifyAuditAction("PLATFORM_TENANT_IMPERSONATE")).toBe("SECURITY");
    expect(classifyAuditAction("CUSTOMER_ERASE")).toBe("PRIVACY");
    expect(classifyAuditAction("REPORT_GENERATED")).toBe("OPERATIONAL");
  });

  it("defaults an unknown action to UNCLASSIFIED, which is preserved", () => {
    // The exact shape the branch adding money-path audit events emits.
    expect(classifyAuditAction("DISBURSEMENT_POSTED")).toBe("UNCLASSIFIED");
    expect(isPurgeableAuditAction("DISBURSEMENT_POSTED")).toBe(false);
    expect(isPurgeableAuditAction("")).toBe(false);
    expect(isPurgeableAuditAction("SOMETHING_NOBODY_HAS_WRITTEN_YET")).toBe(
      false,
    );
  });

  it("treats only OPERATIONAL as disposable", () => {
    for (const action of [
      ...FINANCIAL_AUDIT_ACTIONS,
      ...SECURITY_AUDIT_ACTIONS,
      ...PRIVACY_AUDIT_ACTIONS,
    ]) {
      expect(isPurgeableAuditAction(action)).toBe(false);
    }
    for (const action of OPERATIONAL_AUDIT_ACTIONS) {
      expect(isPurgeableAuditAction(action)).toBe(true);
    }
  });

  it("keeps the disposable list disjoint from every preserved list", () => {
    const preserved = new Set([
      ...FINANCIAL_AUDIT_ACTIONS,
      ...SECURITY_AUDIT_ACTIONS,
      ...PRIVACY_AUDIT_ACTIONS,
    ]);
    const overlap = OPERATIONAL_AUDIT_ACTIONS.filter((a) => preserved.has(a));
    expect(overlap).toEqual([]);
  });

  it("does not classify collection-contact actions as disposable", () => {
    // High-volume and tempting, but they are the contact log a borrower
    // disputes under fair-collection-practice rules. Whether they may
    // expire is a legal question, so the code declines to assume.
    for (const action of [
      "SEND_REMINDER",
      "CALL_BORROWER",
      "FIELD_VISIT",
      "ISSUE_DEMAND_LETTER",
      "ESCALATE_LEGAL",
    ]) {
      expect(isPurgeableAuditAction(action)).toBe(false);
    }
  });
});

describe("purgeableAuditWhere", () => {
  const cutoff = new Date("2020-01-01");

  it("narrows by action and impersonation on top of the date", () => {
    const where = purgeableAuditWhere(cutoff);
    expect(where.createdAt).toEqual({ lt: cutoff });
    expect(where.action.in).toEqual([...OPERATIONAL_AUDIT_ACTIONS]);
    expect(where.impersonatedById).toBeNull();
  });

  it("expresses the action filter as `in` over the closed disposable list", () => {
    // `notIn` over a protected list would fail open: it cannot name the
    // actions that do not exist yet, so anything new would be deletable.
    const where = purgeableAuditWhere(cutoff);
    expect(where.action).not.toHaveProperty("notIn");
    expect(where.action.in).not.toContain("LOAN_APPROVAL_STEP");
    expect(where.action.in.length).toBe(OPERATIONAL_AUDIT_ACTIONS.length);
  });

  it("returns a fresh array so a caller cannot mutate the policy", () => {
    const where = purgeableAuditWhere(cutoff);
    where.action.in.push("LOAN_WRITE_OFF");
    expect(purgeableAuditWhere(cutoff).action.in).not.toContain(
      "LOAN_WRITE_OFF",
    );
  });
});
