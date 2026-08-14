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
  redactableAuditWhere,
  FINANCIAL_AUDIT_ACTIONS,
  MONEY_PATH_AUDIT_ACTIONS,
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

/**
 * The two halves that landed on separate branches, checked against each other.
 *
 * `libs/db` added the money-path audit events and named seven actions that
 * must never come off the general audit clock. `apps/api` added the closed
 * operational list. Neither branch could see the other, so "they compose" was
 * a claim rather than a fact until this ran.
 */
describe("the money-path actions compose with the closed operational list", () => {
  // Written out rather than looped over the constant, so that the seven the
  // libs/db branch named are literally readable here and a future edit to
  // MONEY_PATH_AUDIT_ACTIONS cannot quietly shrink what is being asserted.
  const SEVEN = [
    "LOAN_DISBURSE",
    "LOAN_PAYMENT_RECORD",
    "JOURNAL_POST",
    "JOURNAL_REVERSE",
    "ACCOUNTING_PERIOD_CLOSE",
    "ACCOUNTING_PERIOD_REOPEN",
    "KYC_DECIDE",
  ];

  it("names exactly the seven the libs/db branch specified", () => {
    expect([...MONEY_PATH_AUDIT_ACTIONS].sort()).toEqual([...SEVEN].sort());
  });

  it.each(SEVEN)("%s is not in the disposable list", (action) => {
    // The primary check. `OPERATIONAL_AUDIT_ACTIONS` is the ONLY list that can
    // make a row deletable, so absence from it is what protection means.
    expect(OPERATIONAL_AUDIT_ACTIONS).not.toContain(action);
  });

  it.each(SEVEN)("%s classifies to a preserved class", (action) => {
    // FINANCIAL for JOURNAL_REVERSE, UNCLASSIFIED for the other six — both
    // preserved. UNCLASSIFIED is not a gap: it is the closed list's designed
    // default, and it is why the six that nobody remembered to label are safe.
    expect(classifyAuditAction(action)).not.toBe("OPERATIONAL");
  });

  it.each(SEVEN)("%s is not purgeable at any retention setting", (action) => {
    expect(isPurgeableAuditAction(action)).toBe(false);
  });

  it.each(SEVEN)("%s is excluded by the purge's own where clause", (action) => {
    // Not a restatement of the above: this asserts against the predicate the
    // purge actually sends to the database, which is the thing that deletes.
    const where = purgeableAuditWhere(new Date("2030-01-01"));
    expect(where.action.in).not.toContain(action);
  });

  it("records that six of the seven are protected by DEFAULT, not by naming", () => {
    // Worth pinning explicitly. Only JOURNAL_REVERSE was ever labelled; the
    // other six are safe purely because the operational list is closed. If
    // someone ever inverts that list into a "protected" list, this expectation
    // is what will fail, and it is the one that matters.
    const labelled = SEVEN.filter(
      (a) => classifyAuditAction(a) !== "UNCLASSIFIED",
    );
    expect(labelled).toEqual(["JOURNAL_REVERSE"]);
    expect(FINANCIAL_AUDIT_ACTIONS).toContain("JOURNAL_REVERSE");
  });
});

describe("redactableAuditWhere", () => {
  const cutoff = new Date("2020-01-01");

  it("is the exact complement of the purge within the same cutoff", () => {
    const purge = purgeableAuditWhere(cutoff);
    const redact = redactableAuditWhere(cutoff);
    expect(redact.createdAt).toEqual(purge.createdAt);
    // NOT(operational AND non-impersonated) — the negation of the pair, not
    // of either half alone. Negating only the action list would leave an
    // impersonated report row both undeletable and unredactable.
    expect(redact.NOT.action.in).toEqual([...OPERATIONAL_AUDIT_ACTIONS]);
    expect(redact.NOT.impersonatedById).toBeNull();
  });

  it("skips rows with no PII to clear", () => {
    // Most of the table: rows written before the provenance columns existed,
    // and every job-driven row that had no inbound request.
    const redact = redactableAuditWhere(cutoff);
    expect(redact.OR).toEqual([
      { ipAddress: { not: null } },
      { userAgent: { not: null } },
    ]);
  });

  it("returns a fresh array so a caller cannot mutate the policy", () => {
    const where = redactableAuditWhere(cutoff);
    where.NOT.action.in.push("LOAN_WRITE_OFF");
    expect(redactableAuditWhere(cutoff).NOT.action.in).not.toContain(
      "LOAN_WRITE_OFF",
    );
  });
});
