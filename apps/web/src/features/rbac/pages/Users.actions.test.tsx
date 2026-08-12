import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  loaded,
  mutationHook,
  queryHook,
  renderWithProviders,
} from "../../../test/render";

/**
 * Invariant: the row's actions agree with the row's own Presence
 * column.
 *
 * This one came from a screenshot. The first version of the gate hid
 * "Sign out everywhere" when the user held no live refresh token, which
 * is correct as far as it goes — and it still offered the item on a row
 * the Presence column labelled **Never signed in**, because that user
 * had a token from a login that never made an authenticated call.
 *
 * An operator reads a contradiction on one line and believes the menu
 * over the column. Here the menu would have been the wrong one to
 * believe: there is nothing to sign out. So the gate needs both facts —
 * a live session AND a presence that is not NEVER.
 *
 * OFFLINE is deliberately still offered. That is someone idle since
 * this morning who is genuinely logged in, which is the exact case the
 * action exists for.
 */

const HOOKS = {
  useUsers: queryHook(),
  useRoles: queryHook(),
  useAssignRole: mutationHook(),
  useUnassignRole: mutationHook(),
  useForceLogout: mutationHook(),
  useSetUserActive: mutationHook(),
  useCreateUser: mutationHook(),
  useMyPermissions: queryHook(),
};

vi.mock("@loan/api-client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...HOOKS,
}));

/** The page reads the signed-in user to hide self-targeting actions. */
vi.mock("../../../providers/auth", () => ({
  useAuth: () => ({ user: { id: "me", name: "Admin", email: "a@b.c" } }),
  AuthProvider: ({ children }: { children: unknown }) => children,
}));

interface RowOverrides {
  id?: string;
  name?: string;
  hasActiveSession?: boolean;
  presence?: "ONLINE" | "IDLE" | "OFFLINE" | "NEVER";
  active?: boolean;
}

const user = (o: RowOverrides = {}) => ({
  id: o.id ?? "u1",
  name: o.name ?? "Nina Newbie",
  email: `${o.id ?? "u1"}@loan.local`,
  primaryRole: "OFFICER",
  active: o.active ?? true,
  roles: [],
  hasActiveSession: o.hasActiveSession ?? true,
  presence: o.presence ?? "ONLINE",
  lastSeenAt: "2026-08-11T09:00:00.000Z",
});

async function renderPage(rows: unknown[], permissions: string[]) {
  HOOKS.useUsers.mockReturnValue(loaded(rows));
  HOOKS.useRoles.mockReturnValue(loaded([]));
  HOOKS.useMyPermissions.mockReturnValue(loaded({ permissions }));

  const { UsersPage } = await import("./Users");
  return renderWithProviders(<UsersPage />, { route: "/users" });
}

/** Open the row's overflow menu and return its contents. */
async function openMenu(name: RegExp) {
  const row = screen.getByText(name).closest("tr")!;
  const trigger = within(row).getByRole("button", { name: /more|actions/i });
  await userEvent.click(trigger);
  return screen.getByRole("menu");
}

const ALL = ["admin.users", "admin.force_logout"];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Sign out everywhere", () => {
  it("is offered for someone who is online", async () => {
    // The control case: without it, a gate that hid the item always
    // would pass every negative test below.
    await renderPage([user({ presence: "ONLINE" })], ALL);

    const menu = await openMenu(/Nina Newbie/);
    expect(within(menu).getByText(/sign out everywhere/i)).toBeInTheDocument();
  });

  it("is still offered for someone offline but logged in", async () => {
    /*
     * Idle since this morning is exactly who this action is for.
     * Gating on ONLINE would remove it from the only people an admin
     * ever wants to use it on.
     */
    await renderPage([user({ presence: "OFFLINE" })], ALL);

    const menu = await openMenu(/Nina Newbie/);
    expect(within(menu).getByText(/sign out everywhere/i)).toBeInTheDocument();
  });

  it("is NOT offered for someone the row calls 'never signed in'", async () => {
    /*
     * The screenshot case. A live token from a login that never made an
     * authenticated call — legacy data. The menu must not contradict
     * the column beside it.
     */
    await renderPage(
      [user({ presence: "NEVER", hasActiveSession: true })],
      ALL,
    );

    const menu = await openMenu(/Nina Newbie/);
    expect(
      within(menu).queryByText(/sign out everywhere/i),
    ).not.toBeInTheDocument();
  });

  it("is NOT offered when there is no session at all", async () => {
    await renderPage([user({ hasActiveSession: false })], ALL);

    const menu = await openMenu(/Nina Newbie/);
    expect(
      within(menu).queryByText(/sign out everywhere/i),
    ).not.toBeInTheDocument();
  });

  it("is NOT offered on your own row", async () => {
    // Hidden rather than disabled: the API refuses it, and a greyed
    // item only raises the question of why.
    await renderPage([user({ id: "me", name: "Admin User" })], ALL);

    const menu = await openMenu(/Admin User/);
    expect(
      within(menu).queryByText(/sign out everywhere/i),
    ).not.toBeInTheDocument();
  });

  it("is NOT offered without admin.force_logout", async () => {
    await renderPage([user()], ["admin.users"]);

    const menu = await openMenu(/Nina Newbie/);
    expect(
      within(menu).queryByText(/sign out everywhere/i),
    ).not.toBeInTheDocument();
  });
});

describe("the search field", () => {
  it("filters on name, email and role together", async () => {
    await renderPage(
      [
        user({ id: "u1", name: "Nina Newbie" }),
        user({ id: "u2", name: "Andres Active" }),
      ],
      ALL,
    );

    await userEvent.type(screen.getByLabelText(/search users/i), "andres");

    expect(screen.queryByText(/Nina Newbie/)).not.toBeInTheDocument();
    expect(screen.getByText(/Andres Active/)).toBeInTheDocument();
  });

  it("matches an email the name would not", async () => {
    // Operators paste an address out of a ticket far more often than
    // they type a name.
    await renderPage([user({ id: "u1", name: "Nina Newbie" })], ALL);

    await userEvent.type(
      screen.getByLabelText(/search users/i),
      "u1@loan.local",
    );

    expect(screen.getByText(/Nina Newbie/)).toBeInTheDocument();
  });
});

describe("deactivation", () => {
  it("is not offered on your own row", async () => {
    await renderPage([user({ id: "me", name: "Admin User" })], ALL);

    const menu = await openMenu(/Admin User/);
    expect(within(menu).queryByText(/deactivate/i)).not.toBeInTheDocument();
  });

  it("offers reactivation for someone already deactivated", async () => {
    await renderPage([user({ active: false })], ALL);

    const menu = await openMenu(/Nina Newbie/);
    expect(within(menu).getByText(/activate/i)).toBeInTheDocument();
  });
});
