import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { loaded, queryHook, renderWithProviders } from "../../../test/render";

/**
 * Invariant: a score says which scorecard produced IT — not which one is
 * in force now.
 *
 * `CreditScore.catalogVersion` has been stored since the catalog was
 * versioned, and nothing read it back, so an officer looking at 712 had
 * no way to tell whether it came from today's weights or last March's.
 * The assertions worth having are about MEANING: that the badge tracks
 * the score rather than the catalog, that a closed window reads as a
 * period and an open one as "now", and that a score which predates
 * versioning says so instead of borrowing a version it never used.
 */

const HOOKS = {
  useScoringCatalogHistory: queryHook(),
  useScoringCatalogVersion: queryHook(),
};

vi.mock("@loan/api-client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...HOOKS,
}));

const version = (o: Record<string, unknown>) => ({
  id: `cv${String(o.version)}`,
  version: 1,
  factorCount: 6,
  questionCount: 14,
  effectiveFrom: "2026-03-02T09:00:00.000Z",
  effectiveTo: null,
  changeType: "FACTOR_CHANGED",
  changeSummary: 'weight changed on "income"',
  changeNote: null,
  changedById: "u1",
  ...o,
});

async function renderBadge(catalogVersion: number | null) {
  const { ScorecardVersionBadge } = await import("./ScorecardVersionBadge");
  return renderWithProviders(
    <ScorecardVersionBadge catalogVersion={catalogVersion} />,
  );
}

const badge = () =>
  screen.getByRole("button", { name: /view scorecard history/i });

const open = () => userEvent.click(badge());

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the badge", () => {
  it("names the version that produced the score, not the current one", async () => {
    /*
     * The entire point of the feature. A score computed under v2 stays
     * a v2 score forever, however many revisions land afterwards —
     * reading today's scorecard to explain last quarter's number is a
     * guess that looks like an audit trail.
     */
    HOOKS.useScoringCatalogHistory.mockReturnValue(
      loaded([
        version({ version: 5 }),
        version({
          version: 2,
          effectiveTo: "2026-06-01T00:00:00.000Z",
        }),
      ]),
    );
    await renderBadge(2);

    expect(badge()).toHaveTextContent("v2");
    expect(badge()).not.toHaveTextContent("v5");
  });

  it("shows it on a score from the very first scorecard too", async () => {
    // A version shown only on old scores would read as a warning badge.
    await renderBadge(1);

    expect(badge()).toHaveTextContent("v1");
  });

  it("says the version was never recorded rather than inventing one", async () => {
    /*
     * A score predating catalog versioning has no catalogVersion. The
     * scorecard of the day was genuinely never written down, and
     * displaying the current version here would fabricate exactly the
     * provenance the badge exists to establish.
     */
    HOOKS.useScoringCatalogHistory.mockReturnValue(
      loaded([version({ version: 5 })]),
    );
    await renderBadge(null);

    expect(badge()).toHaveTextContent(/not recorded/i);
    expect(badge()).not.toHaveTextContent(/v\d/);
  });
});

describe("the history panel", () => {
  it("reads the version in force as running until now", async () => {
    HOOKS.useScoringCatalogHistory.mockReturnValue(
      loaded([version({ version: 3, effectiveTo: null })]),
    );
    await renderBadge(3);
    await open();

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/in force .* — now/i)).toBeInTheDocument();
    expect(within(dialog).getByText("Current")).toBeInTheDocument();
  });

  it("reads a superseded version as a closed period", async () => {
    HOOKS.useScoringCatalogHistory.mockReturnValue(
      loaded([
        version({ version: 2, effectiveTo: "2026-06-01T00:00:00.000Z" }),
      ]),
    );
    await renderBadge(2);
    await open();

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByText(/— now/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Current")).not.toBeInTheDocument();
  });

  it("marks which revision this score was computed under", async () => {
    /*
     * Without this the officer has to match a number in the badge
     * against a row by eye — the step that gets skipped.
     */
    HOOKS.useScoringCatalogHistory.mockReturnValue(
      loaded([
        version({ version: 3 }),
        version({ version: 2, effectiveTo: "2026-06-01T00:00:00.000Z" }),
      ]),
    );
    await renderBadge(2);
    await open();

    const marked = within(screen.getByRole("dialog"))
      .getAllByRole("listitem")
      .filter((li) => within(li).queryByText(/scored under this/i) !== null);

    // Exactly one, and it is the revision the score names.
    expect(marked).toHaveLength(1);
    expect(marked.every((li) => within(li).queryByText("v2") !== null)).toBe(
      true,
    );
  });

  it("does not claim any revision when none was recorded", async () => {
    /*
     * The honest null. The revisions are still worth listing, but
     * marking one of them "scored under this" would be a fabrication.
     */
    HOOKS.useScoringCatalogHistory.mockReturnValue(
      loaded([version({ version: 3 }), version({ version: 2 })]),
    );
    await renderBadge(null);
    await open();

    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(/never recorded|not known to be the one used/i),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/scored under this/i)).toBeNull();
  });

  it("shows what a revision's scorecard SAID, not just that it changed", async () => {
    /*
     * The reason this is a list and not a diff: a reviewer asks what the
     * scorecard weighted in a period, and a diff shows the change while
     * hiding the state.
     */
    HOOKS.useScoringCatalogHistory.mockReturnValue(
      loaded([version({ version: 2 })]),
    );
    HOOKS.useScoringCatalogVersion.mockReturnValue(
      loaded({
        ...version({ version: 2 }),
        snapshot: {
          factors: [
            { id: "income", label: "Monthly income", weight: 30 },
            { id: "history", label: "Repayment history", weight: 25 },
          ],
          questions: [],
        },
      }),
    );
    await renderBadge(2);
    await open();
    await userEvent.click(
      screen.getByRole("button", { name: /show scorecard as of v2/i }),
    );

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Monthly income")).toBeInTheDocument();
    expect(within(dialog).getByText("weight 30")).toBeInTheDocument();
  });

  it("fetches a snapshot only when one is asked for", async () => {
    /*
     * A snapshot is the whole catalog. Opening the panel must cost one
     * list request, not one catalog per row.
     */
    HOOKS.useScoringCatalogHistory.mockReturnValue(
      loaded([version({ version: 3 }), version({ version: 2 })]),
    );
    await renderBadge(3);
    await open();

    expect(HOOKS.useScoringCatalogVersion).not.toHaveBeenCalled();
  });

  it("says so plainly when there is no history", async () => {
    HOOKS.useScoringCatalogHistory.mockReturnValue(loaded([]));
    await renderBadge(1);
    await open();

    expect(
      within(screen.getByRole("dialog")).getByText(/no history recorded/i),
    ).toBeInTheDocument();
  });
});
