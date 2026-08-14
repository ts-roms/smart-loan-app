import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { AuditLogRepository } from "./audit-log.repository";
import { LoanRepository } from "./loan.repository";

/**
 * §56 — audit-trail completeness.
 *
 * Two claims are worth pinning here, and they are different claims:
 *
 *   1. The §56 provenance actually reaches the row. Columns that exist
 *      but are never populated are worse than absent columns, because
 *      they read as solved. So the tests assert on the DATA handed to
 *      `auditEvent.create`, not on the schema.
 *
 *   2. The money path cannot commit unaudited. Disbursement and payment
 *      write their audit row on the SAME transaction handle as the
 *      ledger writes, and a failed audit write aborts the whole thing.
 *      Asserting "an audit row was written" would pass even if it were
 *      written after the commit, which is the bug this design exists to
 *      prevent — so the tests check the handle, and check the rollback.
 */

const CTX = {
  tenantId: "mabuhay-coop",
  ipAddress: "203.0.113.44",
  userAgent: "Mozilla/5.0 (branch-terminal)",
  requestId: "1f0c5a3e-77b2-4a91-a0d1-8e6b2c4f9d05",
};

// ── Test doubles ─────────────────────────────────────────────────────────

interface Captured {
  data: Record<string, unknown>;
  /** Which client the write went through — the tx handle, or the base client. */
  via: "tx" | "base";
}

/**
 * The narrowest Prisma stand-in that `recordPayment` and `disburse`
 * touch. `$transaction` hands the callback a DISTINCT object from the
 * base client so the tests can tell which handle a write used — that
 * distinction is the whole point of the placement assertions below.
 */
function makeClient(opts: { auditThrows?: boolean } = {}) {
  const captured: Captured[] = [];
  const committed = { payments: 0, loanUpdates: 0 };
  const rolledBack = { value: false };

  const auditEvent = (via: "tx" | "base") => ({
    create: async ({ data }: { data: Record<string, unknown> }) => {
      if (opts.auditThrows) throw new Error("audit insert failed");
      captured.push({ data, via });
      return { id: "audit-1", ...data };
    },
  });

  const schedules = [
    {
      id: "sched-1",
      loanId: "loan-1",
      installmentNo: 1,
      principalDue: "1000.00",
      interestDue: "100.00",
      principalPaid: "0",
      interestPaid: "0",
      paidInFullAt: null,
      dueDate: new Date("2026-09-01T00:00:00.000Z"),
    },
  ];

  const loan = {
    id: "loan-1",
    number: "LN-0001",
    status: "ACTIVE",
    customerId: "cust-1",
    productCode: "SAL",
    paymentAllocationOrder: "INTEREST_PRINCIPAL",
  };

  const base = {
    loanPayment: { findUnique: async () => null },
    auditEvent: auditEvent("base"),
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        loanApplication: {
          findFirst: async () => ({ ...loan }),
          update: async ({ data }: { data: Record<string, unknown> }) => {
            committed.loanUpdates += 1;
            return { ...loan, ...data };
          },
        },
        loanPayment: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            committed.payments += 1;
            return { id: "pay-1", ...data };
          },
        },
        loanSchedule: {
          findMany: async () => schedules,
          update: async () => schedules[0],
          count: async ({ where }: { where: { paidInFullAt?: null } }) =>
            "paidInFullAt" in where ? 0 : 1,
        },
        auditEvent: auditEvent("tx"),
      };
      try {
        return await fn(tx);
      } catch (err) {
        // A real transaction discards its writes; the counters model that
        // so the rollback assertion is about state, not about the throw.
        rolledBack.value = true;
        committed.payments = 0;
        committed.loanUpdates = 0;
        throw err;
      }
    },
  };

  return {
    client: base as unknown as PrismaClient,
    captured,
    committed,
    rolledBack,
  };
}

/**
 * `recordPaymentUnsafe` does a great deal that is irrelevant here
 * (journal posting, fee computation). This swaps the accounting
 * collaborator for a no-op so the test is about the audit row and not
 * about the ledger, which has its own golden tests.
 */
function silenceAccounting(repo: LoanRepository) {
  (
    repo as unknown as { accounting: { postIfAbsent: () => Promise<null> } }
  ).accounting = { postIfAbsent: async () => null };
}

// ── The §56 fields reach the row ─────────────────────────────────────────

describe("AuditLogRepository — §56 request provenance", () => {
  it("writes tenant, IP, user agent and request id onto the row", async () => {
    const { client, captured } = makeClient();
    const audit = new AuditLogRepository(client, null, { context: CTX });

    await audit.record({ action: "LOAN_DISBURSE", actorId: "officer-1" });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.data).toMatchObject({
      action: "LOAN_DISBURSE",
      actorId: "officer-1",
      tenantId: "mabuhay-coop",
      ipAddress: "203.0.113.44",
      userAgent: "Mozilla/5.0 (branch-terminal)",
      requestId: "1f0c5a3e-77b2-4a91-a0d1-8e6b2c4f9d05",
    });
  });

  it("carries the structured old/new/reason slots §56 asks for", async () => {
    const { client, captured } = makeClient();
    const audit = new AuditLogRepository(client, null, { context: CTX });

    await audit.record({
      action: "KYC_DECIDE",
      actorId: "officer-1",
      oldValue: { status: "PENDING" },
      newValue: { status: "REJECTED" },
      reason: "ID photo did not match the applicant",
    });

    expect(captured[0]!.data).toMatchObject({
      oldValue: { status: "PENDING" },
      newValue: { status: "REJECTED" },
      reason: "ID photo did not match the applicant",
    });
  });

  it("truncates a hostile User-Agent rather than storing it whole", async () => {
    const { client, captured } = makeClient();
    const audit = new AuditLogRepository(client, null, {
      context: { ...CTX, userAgent: "A".repeat(5000) },
    });

    await audit.record({ action: "LOAN_DISBURSE", actorId: "officer-1" });

    expect((captured[0]!.data.userAgent as string).length).toBe(512);
  });

  it("lets a per-call null context suppress the request's own — a job must not inherit an IP", async () => {
    const { client, captured } = makeClient();
    const audit = new AuditLogRepository(client, null, { context: CTX });

    await audit.record({
      action: "JOB_RUN",
      actorId: "system",
      context: null,
    });

    expect(captured[0]!.data.ipAddress).toBeUndefined();
    expect(captured[0]!.data.requestId).toBeUndefined();
  });
});

// ── Failures are reported, not swallowed ─────────────────────────────────

describe("AuditLogRepository — failure handling", () => {
  it("reports a failed write through the injected logger, not console.error", async () => {
    const { client } = makeClient({ auditThrows: true });
    const logger = { error: vi.fn() };
    const audit = new AuditLogRepository(client, null, {
      context: CTX,
      logger,
    });

    const result = await audit.record({
      action: "REPORT_EXPORT",
      actorId: "officer-1",
    });

    // Best-effort by default: the business action is not disturbed.
    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledTimes(1);
    // Structured, and carrying the request id — the join key back to the
    // request that lost its audit row.
    const [payload] = logger.error.mock.calls[0]!;
    expect(payload).toMatchObject({
      action: "REPORT_EXPORT",
      requestId: CTX.requestId,
      required: false,
    });
  });

  it("rethrows for a privileged action so the caller's transaction cannot commit", async () => {
    const { client } = makeClient({ auditThrows: true });
    const logger = { error: vi.fn() };
    const audit = new AuditLogRepository(client, null, {
      context: CTX,
      logger,
    });

    await expect(
      audit.recordRequired({ action: "LOAN_DISBURSE", actorId: "officer-1" }),
    ).rejects.toThrow("audit insert failed");
    expect(logger.error.mock.calls[0]![0]).toMatchObject({ required: true });
  });
});

// ── The money path ───────────────────────────────────────────────────────

describe("§56 money path — a payment writes an audit row", () => {
  it("records LOAN_PAYMENT_RECORD carrying the new fields", async () => {
    const { client, captured } = makeClient();
    const audit = new AuditLogRepository(client, null, { context: CTX });
    const repo = new LoanRepository(client);
    silenceAccounting(repo);

    await repo.recordPayment("loan-1", {
      amount: 500,
      paidOn: new Date("2026-08-14T00:00:00.000Z"),
      recordedById: "cashier-9",
      reference: "OR-4471",
      audit,
    });

    expect(captured).toHaveLength(1);
    const row = captured[0]!;
    expect(row.data).toMatchObject({
      action: "LOAN_PAYMENT_RECORD",
      actorId: "cashier-9",
      targetType: "LoanPayment",
      tenantId: "mabuhay-coop",
      ipAddress: "203.0.113.44",
      requestId: CTX.requestId,
    });
    expect(row.data.userAgent).toBe(CTX.userAgent);
  });

  it("writes it on the payment's own transaction handle, not after the commit", async () => {
    const { client, captured } = makeClient();
    const audit = new AuditLogRepository(client, null, { context: CTX });
    const repo = new LoanRepository(client);
    silenceAccounting(repo);

    await repo.recordPayment("loan-1", {
      amount: 500,
      paidOn: new Date("2026-08-14T00:00:00.000Z"),
      recordedById: "cashier-9",
      audit,
    });

    // The distinction that matters: `base` would mean the row was written
    // outside the transaction, leaving a window where money has moved and
    // nothing says who moved it.
    expect(captured[0]!.via).toBe("tx");
  });

  it("rolls the payment back when the audit write fails", async () => {
    const { client, committed, rolledBack } = makeClient({
      auditThrows: true,
    });
    const audit = new AuditLogRepository(client, null, {
      context: CTX,
      logger: { error: vi.fn() },
    });
    const repo = new LoanRepository(client);
    silenceAccounting(repo);

    await expect(
      repo.recordPayment("loan-1", {
        amount: 500,
        paidOn: new Date("2026-08-14T00:00:00.000Z"),
        recordedById: "cashier-9",
        audit,
      }),
    ).rejects.toThrow("audit insert failed");

    expect(rolledBack.value).toBe(true);
    expect(committed.payments).toBe(0);
  });

  it("does not double-audit an idempotent replay — the replay moved no money", async () => {
    const { client, captured } = makeClient();
    const audit = new AuditLogRepository(client, null, { context: CTX });
    const repo = new LoanRepository(client);
    silenceAccounting(repo);
    // A key whose payment already exists: `recordPayment` answers from the
    // existing row without re-entering the transaction.
    (
      client as unknown as { loanPayment: { findUnique: () => unknown } }
    ).loanPayment.findUnique = async () => ({ id: "pay-1" });

    await repo.recordPayment("loan-1", {
      amount: 500,
      paidOn: new Date("2026-08-14T00:00:00.000Z"),
      recordedById: "cashier-9",
      idempotencyKey: "retry-abc123",
      audit,
    });

    expect(captured).toHaveLength(0);
  });

  it("still records a payment when no audit sink is supplied — the sink is optional", async () => {
    const { client, captured, committed } = makeClient();
    const repo = new LoanRepository(client);
    silenceAccounting(repo);

    await repo.recordPayment("loan-1", {
      amount: 500,
      paidOn: new Date("2026-08-14T00:00:00.000Z"),
      recordedById: "cashier-9",
    });

    expect(committed.payments).toBe(1);
    expect(captured).toHaveLength(0);
  });
});

// ── Disbursement ─────────────────────────────────────────────────────────

const PRODUCT = {
  id: "p1",
  code: "SALARY",
  name: "Salary Loan",
  interestMethod: "DECLINING",
  paymentFrequency: "MONTHLY",
  processingFeeRate: 0.01,
  processingFeeFlat: 0,
  documentaryStampRate: 0,
  preTerminationFeeRate: 0.02,
  isLease: false,
  residualValueFraction: null,
};

/**
 * A Prisma stand-in for the disbursement path. Same `tx`-vs-`base`
 * distinction as `makeClient` — the point of the assertions below is
 * WHERE the audit row is written, not merely that it is.
 */
function makeDisburseClient(opts: { auditThrows?: boolean } = {}) {
  const captured: Captured[] = [];
  const state = { status: "APPROVED", scheduleRows: 0, statusWrites: 0 };
  const rolledBack = { value: false };

  const loan = () => ({
    id: "loan-1",
    number: "LN-0001",
    status: state.status,
    customerId: "cust-1",
    productCode: "SALARY",
    principal: 30000,
    termMonths: 3,
    annualInterestRate: 0.12,
    disbursedAt: null,
    disbursedById: null,
    renewedFromId: null,
    restructuredFromId: null,
    agentId: null,
    agentCommissionPostedAt: null,
    agentCommissionAmount: 0,
    product: PRODUCT,
  });

  const auditEvent = (via: "tx" | "base") => ({
    create: async ({ data }: { data: Record<string, unknown> }) => {
      if (opts.auditThrows) throw new Error("audit insert failed");
      captured.push({ data, via });
      return { id: "audit-1", ...data };
    },
  });

  const base = {
    auditEvent: auditEvent("base"),
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        loanApplication: {
          findFirst: async () => loan(),
          findUnique: async () => ({ status: state.status }),
          updateMany: async ({ data }: { data: { status?: string } }) => {
            // The state claim that makes disbursement one-shot.
            if (state.status !== "APPROVED") return { count: 0 };
            if (data.status) state.status = data.status;
            return { count: 1 };
          },
          update: async ({ data }: { data: Record<string, unknown> }) => {
            state.statusWrites += 1;
            return { ...loan(), ...data };
          },
        },
        loanSchedule: {
          createMany: async ({ data }: { data: unknown[] }) => {
            state.scheduleRows += data.length;
            return { count: data.length };
          },
        },
        auditEvent: auditEvent("tx"),
      };
      try {
        return await fn(tx);
      } catch (err) {
        rolledBack.value = true;
        state.scheduleRows = 0;
        state.statusWrites = 0;
        state.status = "APPROVED";
        throw err;
      }
    },
  };

  return {
    client: base as unknown as PrismaClient,
    captured,
    state,
    rolledBack,
  };
}

describe("§56 money path — a disbursement writes an audit row", () => {
  it("records LOAN_DISBURSE carrying the new fields", async () => {
    const { client, captured } = makeDisburseClient();
    const audit = new AuditLogRepository(client, null, { context: CTX });
    const repo = new LoanRepository(client);
    silenceAccounting(repo);

    await repo.disburse("loan-1", { disbursedById: "officer-1", audit });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.data).toMatchObject({
      action: "LOAN_DISBURSE",
      actorId: "officer-1",
      targetType: "LoanApplication",
      targetId: "loan-1",
      tenantId: "mabuhay-coop",
      ipAddress: "203.0.113.44",
      userAgent: "Mozilla/5.0 (branch-terminal)",
      requestId: "1f0c5a3e-77b2-4a91-a0d1-8e6b2c4f9d05",
    });
  });

  it("captures the status transition in the structured old/new slots", async () => {
    const { client, captured } = makeDisburseClient();
    const audit = new AuditLogRepository(client, null, { context: CTX });
    const repo = new LoanRepository(client);
    silenceAccounting(repo);

    await repo.disburse("loan-1", { disbursedById: "officer-1", audit });

    const row = captured[0]!.data as {
      oldValue: { status: string };
      newValue: { status: string; disbursedById: string };
    };
    expect(row.oldValue.status).toBe("APPROVED");
    expect(row.newValue.status).toBe("ACTIVE");
    expect(row.newValue.disbursedById).toBe("officer-1");
  });

  it("writes it on the disbursement's own transaction handle", async () => {
    const { client, captured } = makeDisburseClient();
    const audit = new AuditLogRepository(client, null, { context: CTX });
    const repo = new LoanRepository(client);
    silenceAccounting(repo);

    await repo.disburse("loan-1", { disbursedById: "officer-1", audit });

    expect(captured[0]!.via).toBe("tx");
  });

  it("rolls the disbursement back when the audit write fails", async () => {
    const { client, state, rolledBack } = makeDisburseClient({
      auditThrows: true,
    });
    const audit = new AuditLogRepository(client, null, {
      context: CTX,
      logger: { error: vi.fn() },
    });
    const repo = new LoanRepository(client);
    silenceAccounting(repo);

    await expect(
      repo.disburse("loan-1", { disbursedById: "officer-1", audit }),
    ).rejects.toThrow("audit insert failed");

    // The property §56 is really asking for: money cannot have moved.
    expect(rolledBack.value).toBe(true);
    expect(state.scheduleRows).toBe(0);
    expect(state.status).toBe("APPROVED");
  });
});
