import type { Customer } from "@loan/shared-types";
import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  loaded,
  mutationHook,
  queryHook,
  renderWithProviders,
} from "../../../test/render";

/**
 * Invariant: an erased or archived customer offers no way to edit their
 * profile or start a loan.
 *
 * These two controls are the reason this file exists rather than a
 * snapshot of the page. Both were added as server-side guards
 * (`290cf18`) after the UI ones, which is the right order — but the UI
 * guard is what stops the mistake from being made, and a UI guard has
 * no test to break when someone refactors the header.
 *
 * What "erased" means here: the customer exercised a data-privacy
 * erasure. Their financial history is retained because the law requires
 * it, and every identifying field now holds a placeholder. Offering
 * "Edit profile" on that record invites staff to type fresh PII into a
 * record the organisation has just certified as redacted. "Apply for a
 * loan" is worse — underwriting an identity that no longer exists.
 *
 * Archived is a different fact with the same two consequences: the
 * member is out of the borrower pool, and the record is meant to be
 * inert rather than edited.
 */

/** A settled query with nothing in it. The child panels' default. */
const HOOKS = {
  // Read by the page itself; each test sets these.
  useCustomer: queryHook(),
  useCustomerScore: queryHook(),
  useKycForCustomer: queryHook(),
  useKycStatus: queryHook(),
  useSubmitKyc: mutationHook(),
  useArchiveCustomer: mutationHook(),
  useMyPermissions: queryHook(),
  // Read by the child panels. Left empty on purpose — the ledger and
  // the loan list are not what this file is about, and giving them data
  // would only add rows for an assertion to trip over.
  useCustomerLedger: queryHook(),
  useLoans: queryHook(),
  useDorsiForCustomer: queryHook(),
  useScreenDorsiByName: mutationHook(),
};

/*
 * Mock the whole module, keeping the real exports underneath.
 *
 * The page reaches this module transitively through its child panels
 * too — the ledger, the loans list, the AML banner. Replacing only the
 * named hooks and leaving the rest real means a new import in a child
 * component does not break this file with "not a function", which
 * would be a maintenance tax with no diagnostic value. The children
 * still fetch nothing: setup.ts fails any test that reaches the
 * network.
 */
vi.mock("@loan/api-client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...HOOKS,
}));

const BASE: Customer = {
  id: "c1",
  number: "CUST-2026-000001",
  firstName: "Clara",
  middleName: null,
  lastName: "Clean",
  dateOfBirth: "1990-01-01T00:00:00.000Z",
  phone: "09170000001",
  email: "clara@example.com",
  erasedAt: null,
  archivedAt: null,
  archiveReason: null,
} as unknown as Customer;

/** Import after the mock is registered. */
async function renderPage(customer: Customer, permissions: string[]) {
  HOOKS.useCustomer.mockReturnValue(loaded(customer));
  HOOKS.useCustomerScore.mockReturnValue(loaded(undefined));
  HOOKS.useKycForCustomer.mockReturnValue(loaded([]));
  HOOKS.useKycStatus.mockReturnValue(loaded(undefined));
  HOOKS.useMyPermissions.mockReturnValue(loaded({ permissions }));

  const { CustomerDetailPage } = await import("./CustomerDetail");
  return renderWithProviders(<CustomerDetailPage />, {
    route: `/customers/${customer.id}`,
    path: "/customers/:id",
  });
}

const editButton = () =>
  screen.queryByRole("button", { name: /edit profile/i });
const applyLink = () =>
  screen.queryByRole("link", { name: /apply for a loan/i });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a live customer", () => {
  it("offers both controls", async () => {
    // The control case. Without it, a guard that hid the buttons
    // unconditionally would pass every test below.
    await renderPage(BASE, ["loans.apply"]);

    expect(editButton()).toBeInTheDocument();
    expect(applyLink()).toBeInTheDocument();
  });

  it("hides the apply link from someone without loans.apply", async () => {
    // Gated on the same key the API requires, so a collector never sees
    // a button that will 403 on them.
    await renderPage(BASE, []);

    expect(editButton()).toBeInTheDocument();
    expect(applyLink()).not.toBeInTheDocument();
  });
});

describe("an erased customer", () => {
  const erased = {
    ...BASE,
    erasedAt: "2026-07-01T00:00:00.000Z",
  } as unknown as Customer;

  it("offers no way to edit the profile", async () => {
    await renderPage(erased, ["loans.apply"]);

    expect(editButton()).not.toBeInTheDocument();
  });

  it("offers no way to start a loan, even with the permission", async () => {
    // The permission is held. It is the customer's state that refuses.
    await renderPage(erased, ["loans.apply"]);

    expect(applyLink()).not.toBeInTheDocument();
  });

  it("says why, so the record does not read as data loss", async () => {
    /*
     * A record full of "[ERASED]" placeholders with no explanation
     * reads as a bug, and staff file it as one.
     */
    await renderPage(erased, ["loans.apply"]);

    expect(screen.getByText(/personal data erased/i)).toBeInTheDocument();
    expect(screen.getByText(/retained as required by/i)).toBeInTheDocument();
    expect(screen.getByText("Erased")).toBeInTheDocument();
  });
});

describe("an archived customer", () => {
  const archived = {
    ...BASE,
    archivedAt: "2026-07-01T00:00:00.000Z",
    archiveReason: "Left the cooperative",
  } as unknown as Customer;

  it("hides both controls", async () => {
    await renderPage(archived, ["loans.apply"]);

    expect(editButton()).not.toBeInTheDocument();
    expect(applyLink()).not.toBeInTheDocument();
  });

  it("says the state is reversible, unlike erasure", async () => {
    // The two banners must not read the same. Archiving is a decision
    // that can be taken back; erasure is not.
    await renderPage(archived, ["loans.apply"]);

    expect(screen.getByText(/this can be undone/i)).toBeInTheDocument();
    expect(screen.getByText(/Left the cooperative/)).toBeInTheDocument();
    expect(screen.queryByText(/permanently redacted/i)).not.toBeInTheDocument();
  });
});
