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
 * Invariant: the page shows which revision of a rule is in force, and
 * can show what the earlier ones said.
 *
 * Rules used to be one mutable row each. Retuning one destroyed the
 * only copy of what it used to say, so a loan approved in March could
 * only ever be explained with today's threshold. The API side of that
 * is covered by `decision-rule.versioning.test.ts`; this covers the
 * half an operator actually touches.
 *
 * The assertions worth having are the ones about MEANING rather than
 * markup — that a closed window reads as a period and an open one reads
 * as "now", that a withdrawal does not read as a period at all, and
 * that "Retire" does not read like "Delete".
 */

const HOOKS = {
  useDecisionRules: queryHook(),
  useDecisionRuleHistory: queryHook(),
  useCreateDecisionRule: mutationHook(),
  useUpdateDecisionRule: mutationHook(),
  useDeleteDecisionRule: mutationHook(),
  useSeedDecisionRules: mutationHook(),
  useMyPermissions: queryHook(),
};

vi.mock("@loan/api-client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...HOOKS,
}));

const RULE = {
  id: "r1",
  name: "B tier moderate fast-track",
  description: null,
  priority: 110,
  conditions: [{ field: "tierAtApply", op: "=", value: "B" }],
  action: "AUTO_APPROVE",
  reason: "B tier, within limits.",
  active: true,
  version: 3,
  effectiveFrom: "2026-08-11T09:00:00.000Z",
  retiredAt: null,
  createdAt: "2026-08-03T03:58:46.000Z",
  updatedAt: "2026-08-11T09:00:00.000Z",
};

const version = (o: Record<string, unknown>) => ({
  id: `v${String(o.version)}`,
  ruleId: "r1",
  ruleName: RULE.name,
  description: null,
  priority: 110,
  conditions: [{ field: "tierAtApply", op: "=", value: "B" }],
  action: "AUTO_APPROVE",
  reason: null,
  active: true,
  effectiveFrom: "2026-08-03T03:58:46.000Z",
  effectiveTo: null,
  changeType: "UPDATE",
  changeNote: null,
  changedById: "u1",
  ...o,
});

async function renderPage(
  rules = [RULE],
  permissions = ["admin.decision_rules"],
) {
  HOOKS.useDecisionRules.mockReturnValue(loaded(rules));
  HOOKS.useMyPermissions.mockReturnValue(loaded({ permissions }));

  const { DecisionRulesPage } = await import("./DecisionRules");
  return renderWithProviders(<DecisionRulesPage />, {
    route: "/decision-rules",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the rule list", () => {
  it("shows which revision is in force", async () => {
    await renderPage();

    expect(
      screen.getByRole("button", { name: /view change history/i }),
    ).toHaveTextContent("v3");
  });

  it("shows it on a rule that has never been edited too", async () => {
    /*
     * A version number that appeared only on edited rules would read as
     * a warning badge. Present on all of them, it reads as what it is.
     */
    await renderPage([{ ...RULE, version: 1 }]);

    expect(
      screen.getByRole("button", { name: /view change history/i }),
    ).toHaveTextContent("v1");
  });

  it("says Retire, not Delete", async () => {
    /*
     * The word is the whole point. DELETE on this endpoint withdraws
     * the rule and keeps its history, because every loan citing it has
     * to stay explainable — and an operator who reads "Delete" will not
     * believe that.
     */
    await renderPage();

    expect(screen.getByRole("button", { name: /retire/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^delete$/i }),
    ).not.toBeInTheDocument();
  });

  it("offers no edit controls without admin.decision_rules", async () => {
    // Reading rules is `loans.read` — an officer explaining a decision
    // needs to see them. Changing them is not.
    await renderPage([RULE], ["loans.read"]);

    expect(
      screen.queryByRole("button", { name: /retire/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /new rule/i }),
    ).not.toBeInTheDocument();
    // The version badge stays: it is information, not a control.
    expect(
      screen.getByRole("button", { name: /view change history/i }),
    ).toBeInTheDocument();
  });
});

describe("the history panel", () => {
  const open = async () =>
    userEvent.click(
      screen.getByRole("button", { name: /view change history/i }),
    );

  it("reads the current version as in force until now", async () => {
    HOOKS.useDecisionRuleHistory.mockReturnValue(
      loaded([version({ version: 2, effectiveTo: null })]),
    );
    await renderPage();
    await open();

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/in force .* — now/i)).toBeInTheDocument();
    expect(within(dialog).getByText("Current")).toBeInTheDocument();
  });

  it("reads a superseded version as a closed period", async () => {
    HOOKS.useDecisionRuleHistory.mockReturnValue(
      loaded([
        version({
          version: 1,
          effectiveTo: "2026-08-11T09:00:00.000Z",
          changeType: "CREATE",
        }),
      ]),
    );
    await renderPage();
    await open();

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByText(/— now/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByText("Current")).not.toBeInTheDocument();
  });

  it("reads a withdrawal as an event, not a period", async () => {
    /*
     * A RETIRE row has effectiveTo === effectiveFrom — a zero-width
     * window, because that text of the rule was never in force.
     * Rendering it as "in force X — X" would invite someone to read it
     * as a period the rule applied in.
     */
    HOOKS.useDecisionRuleHistory.mockReturnValue(
      loaded([
        version({
          version: 3,
          changeType: "RETIRE",
          active: false,
          effectiveFrom: "2026-08-11T10:00:00.000Z",
          effectiveTo: "2026-08-11T10:00:00.000Z",
          changeNote: "Superseded by the new tier bands.",
        }),
      ]),
    );
    await renderPage();
    await open();

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/^Withdrawn /)).toBeInTheDocument();
    expect(within(dialog).queryByText(/in force/i)).not.toBeInTheDocument();
    expect(within(dialog).getByText("Retired")).toBeInTheDocument();
  });

  it("shows what each version REQUIRED, not just that it changed", async () => {
    /*
     * The reason this is a list and not a diff. An auditor asks what
     * the rule demanded in a period; a diff shows the change while
     * hiding the state.
     */
    HOOKS.useDecisionRuleHistory.mockReturnValue(
      loaded([
        version({
          version: 2,
          conditions: [{ field: "creditScoreAtApply", op: ">=", value: 700 }],
        }),
        version({
          version: 1,
          effectiveTo: "2026-08-11T09:00:00.000Z",
          conditions: [{ field: "creditScoreAtApply", op: ">=", value: 650 }],
        }),
      ]),
    );
    await renderPage();
    await open();

    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText("creditScoreAtApply >= 700"),
    ).toBeInTheDocument();
    // The old floor is still readable. This is the whole feature.
    expect(
      within(dialog).getByText("creditScoreAtApply >= 650"),
    ).toBeInTheDocument();
  });

  it("shows the note explaining a change when one was left", async () => {
    HOOKS.useDecisionRuleHistory.mockReturnValue(
      loaded([
        version({
          version: 2,
          changeNote: "Raised the floor after the Q2 delinquency review.",
        }),
      ]),
    );
    await renderPage();
    await open();

    expect(
      within(screen.getByRole("dialog")).getByText(/Q2 delinquency review/),
    ).toBeInTheDocument();
  });

  it("says so plainly when there is no history", async () => {
    HOOKS.useDecisionRuleHistory.mockReturnValue(loaded([]));
    await renderPage();
    await open();

    expect(
      within(screen.getByRole("dialog")).getByText(/no history recorded/i),
    ).toBeInTheDocument();
  });
});

describe("the edit dialog", () => {
  it("asks what changed, so the history is worth reading", async () => {
    await renderPage();
    await userEvent.click(screen.getByRole("button", { name: /edit/i }));

    expect(screen.getByLabelText(/what changed/i)).toBeInTheDocument();
  });

  it("does not ask on create — there is nothing to compare to", async () => {
    await renderPage();
    await userEvent.click(screen.getByRole("button", { name: /new rule/i }));

    expect(screen.queryByLabelText(/what changed/i)).not.toBeInTheDocument();
  });
});
