/**
 * Portal service — ownership-scoping coverage.
 *
 * The portal is implicitly scoped to one customer: the JWT subject's
 * linked Customer row. Every endpoint that takes an id (loan, payment
 * intent, customer document) MUST refuse if that id belongs to a
 * different customer. A regression that drops the ownership check
 * leaks one borrower's data to another — a data-protection incident,
 * not just a bug.
 *
 * Coverage:
 *   - `resolveCustomerId` — the JWT-to-customer mapping. Returns
 *     NotLinked unless the user is role=CUSTOMER AND has a customerId.
 *   - `getLoan` — refuses cross-customer access to loan reads.
 *   - `signBorrower` — refuses cross-customer signature writes (a
 *     borrower forging another borrower's signature).
 *   - `createIntent` — refuses cross-customer payment intent creation.
 *   - `getIntent` — refuses cross-customer intent reads.
 *
 * All four ownership checks return `{ ok: false, kind: "NotFound" }`
 * — using 404 instead of 403 to avoid leaking existence. The tests
 * verify both that the wrong-customer case is refused AND that no
 * downstream write happens on the rejected path.
 */

import { describe, expect, it, vi } from "vitest";

import { PortalService } from "./portal.service";

interface MockOptions {
  user?: { role: string; customerId: string | null } | null;
  loanByIdOrNumber?: { id: string; customerId: string } | null;
  loanByPk?: { customerId: string } | null;
  intent?: { loanId: string } | null;
}

function makeService(opts: MockOptions = {}) {
  const userFindUnique = vi.fn().mockResolvedValue(opts.user ?? null);
  const loanFindUnique = vi.fn().mockResolvedValue(opts.loanByPk ?? null);
  const loanUpdate = vi.fn().mockImplementation(async ({ where, data }) => ({
    id: where.id,
    ...data,
  }));
  const prisma = {
    user: { findUnique: userFindUnique },
    loanApplication: { findUnique: loanFindUnique, update: loanUpdate },
  };
  const loans = {
    findByIdOrNumber: vi.fn().mockResolvedValue(opts.loanByIdOrNumber ?? null),
  };
  const intents = {
    findByIdOrNumber: vi.fn().mockResolvedValue(opts.intent ?? null),
    create: vi.fn().mockResolvedValue({ id: "intent-new" }),
  };

  const service = new PortalService(
    prisma as never,
    loans as never,
    {} as never, // scores — used by getMe / applyLoan; not exercised here
    {} as never, // kyc
    {} as never, // coop
    {} as never, // ledger
    intents as never,
    "https://example.test/webhook",
    {} as never, // preAssessments — not exercised here
  );

  return { service, prisma, loans, intents, loanUpdate };
}

describe("PortalService.resolveCustomerId — JWT-to-customer mapping", () => {
  it("returns NotLinked when the user does not exist", async () => {
    const { service } = makeService({ user: null });
    const result = await service.resolveCustomerId("user-ghost");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("NotLinked");
    expect(result.message).toMatch(/CUSTOMER account linked/i);
  });

  it("returns NotLinked when the user is a staff role (ADMIN/LOAN_OFFICER/etc)", async () => {
    // A staff user has no business calling the portal — even if a stray
    // route bug let them through, resolveCustomerId is the second gate.
    const { service } = makeService({
      user: { role: "ADMIN", customerId: "cust-1" },
    });
    const result = await service.resolveCustomerId("user-admin");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("NotLinked");
  });

  it("returns NotLinked when CUSTOMER user has no linked customerId", async () => {
    // Edge case: a CUSTOMER user whose `customerId` is null. Possible
    // mid-onboarding or after a manual data fix. The portal must refuse.
    const { service } = makeService({
      user: { role: "CUSTOMER", customerId: null },
    });
    const result = await service.resolveCustomerId("user-pending");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("NotLinked");
  });

  it("returns the customerId for a properly linked CUSTOMER user", async () => {
    const { service } = makeService({
      user: { role: "CUSTOMER", customerId: "cust-alice" },
    });
    const result = await service.resolveCustomerId("user-alice");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("type narrow");
    expect(result.customerId).toBe("cust-alice");
  });
});

describe("PortalService.getLoan — cross-customer access", () => {
  it("refuses when the loan belongs to a different customer", async () => {
    const { service, loans } = makeService({
      loanByIdOrNumber: { id: "loan-1", customerId: "cust-bob" },
    });
    const result = await service.getLoan("cust-alice", "L-001");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("NotFound");
    // The repo IS hit (we need to read the loan to know the customer);
    // the check is post-fetch. We're verifying the response doesn't
    // leak the row.
    expect(loans.findByIdOrNumber).toHaveBeenCalledWith("L-001");
  });

  it("returns the loan when it belongs to the calling customer", async () => {
    const loan = { id: "loan-1", customerId: "cust-alice", number: "L-001" };
    const { service } = makeService({ loanByIdOrNumber: loan });
    const result = await service.getLoan("cust-alice", "L-001");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("type narrow");
    expect(result.value).toBe(loan);
  });

  it("returns NotFound (not 500) when the loan id doesn't exist at all", async () => {
    const { service } = makeService({ loanByIdOrNumber: null });
    const result = await service.getLoan("cust-alice", "L-missing");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("NotFound");
  });
});

describe("PortalService.signBorrower — cross-customer signature forging", () => {
  it("refuses to write a signature on another borrower's loan", async () => {
    const { service, loanUpdate } = makeService({
      loanByPk: { customerId: "cust-bob" },
    });
    const result = await service.signBorrower({
      customerId: "cust-alice",
      loanId: "loan-1",
      signatureUrl: "data:image/png;base64,iVBOR...",
      ip: "127.0.0.1",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("NotFound");
    // CRITICAL: no write must happen. A regression that updated the
    // signature before the ownership check would corrupt another
    // borrower's loan record.
    expect(loanUpdate).not.toHaveBeenCalled();
  });

  it("writes the signature when the loan belongs to the calling customer", async () => {
    const { service, loanUpdate } = makeService({
      loanByPk: { customerId: "cust-alice" },
    });
    const result = await service.signBorrower({
      customerId: "cust-alice",
      loanId: "loan-1",
      signatureUrl: "data:image/png;base64,iVBOR...",
      ip: "10.0.0.1",
    });

    expect(result.ok).toBe(true);
    expect(loanUpdate).toHaveBeenCalledWith({
      where: { id: "loan-1" },
      data: expect.objectContaining({
        borrowerSignatureUrl: "data:image/png;base64,iVBOR...",
        borrowerSignedFromIp: "10.0.0.1",
      }),
    });
  });

  it("refuses when the loan id doesn't exist", async () => {
    const { service, loanUpdate } = makeService({ loanByPk: null });
    const result = await service.signBorrower({
      customerId: "cust-alice",
      loanId: "loan-ghost",
      signatureUrl: "x",
      ip: "127.0.0.1",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("NotFound");
    expect(loanUpdate).not.toHaveBeenCalled();
  });
});

describe("PortalService.createIntent — cross-customer payment fabrication", () => {
  it("refuses to create an intent against another borrower's loan", async () => {
    const { service, intents } = makeService({
      loanByPk: { customerId: "cust-bob" },
    });
    const result = await service.createIntent({
      customerId: "cust-alice",
      userId: "user-alice",
      input: { loanId: "loan-bob", amount: 5000 },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("NotFound");
    // CRITICAL: no payment intent must be created against the wrong
    // loan. A regression here would let one customer initiate
    // payments on behalf of another.
    expect(intents.create).not.toHaveBeenCalled();
  });

  it("creates the intent when the loan belongs to the calling customer", async () => {
    const { service, intents } = makeService({
      loanByPk: { customerId: "cust-alice" },
    });
    const result = await service.createIntent({
      customerId: "cust-alice",
      userId: "user-alice",
      input: { loanId: "loan-1", amount: 5000 },
    });

    expect(result.ok).toBe(true);
    expect(intents.create).toHaveBeenCalledWith(
      expect.objectContaining({
        loanId: "loan-1",
        amount: 5000,
        createdById: "user-alice",
      }),
    );
  });
});

describe("PortalService.getIntent — cross-customer intent reads", () => {
  it("refuses when the intent's loan belongs to a different customer", async () => {
    // Two-step ownership: the intent itself doesn't carry a customerId,
    // but its `loanId` does (indirectly). The service fetches the
    // intent, then resolves the loan's customer, then checks. A
    // regression that skipped step 2 would leak intent details across
    // customers.
    const { service } = makeService({
      intent: { loanId: "loan-bob" },
      loanByPk: { customerId: "cust-bob" },
    });
    const result = await service.getIntent("cust-alice", "intent-1");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("NotFound");
  });

  it("returns the intent when it's chained to the caller's loan", async () => {
    const intent = { loanId: "loan-1", id: "intent-1" };
    const { service } = makeService({
      intent,
      loanByPk: { customerId: "cust-alice" },
    });
    const result = await service.getIntent("cust-alice", "intent-1");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("type narrow");
    expect(result.value).toBe(intent);
  });

  it("returns NotFound when the intent id doesn't exist", async () => {
    const { service } = makeService({ intent: null });
    const result = await service.getIntent("cust-alice", "intent-ghost");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("type narrow");
    expect(result.kind).toBe("NotFound");
  });
});
