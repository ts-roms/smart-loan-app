import { type DecisionRuleRepository } from "@loan/db";

import type { CreateRuleInput, UpdateRuleInput } from "./schemas";

/**
 * Decision-rule orchestration. Mostly a thin pass-through over the
 * repo; the create path catches unique-name conflicts and surfaces
 * them as a discriminated union so the controller can render a 409.
 */

type RuleRow = Awaited<ReturnType<DecisionRuleRepository["create"]>>;

export type CreateResult =
  | { ok: true; rule: RuleRow }
  | { ok: false; kind: "Conflict"; message: string };

export class DecisionRuleService {
  constructor(private readonly repo: DecisionRuleRepository) {}

  list() {
    return this.repo.list();
  }

  history(ruleId: string) {
    return this.repo.historyFor(ruleId);
  }

  /** The rule set in force at a moment; defaults to now. */
  asOf(at?: Date) {
    return this.repo.asOf(at ?? new Date());
  }

  async create(
    input: CreateRuleInput,
    actorId?: string,
  ): Promise<CreateResult> {
    try {
      return {
        ok: true,
        rule: await this.repo.create(input, { changedById: actorId }),
      };
    } catch (err) {
      return { ok: false, kind: "Conflict", message: (err as Error).message };
    }
  }

  update(id: string, input: UpdateRuleInput, actorId?: string) {
    const { changeNote, ...fields } = input;
    return this.repo.update(id, fields, {
      changedById: actorId,
      changeNote,
    });
  }

  /**
   * DELETE retires rather than erases.
   *
   * Dropping the row would cascade its history away and leave every loan
   * whose approval cites it pointing at nothing — the decisions would
   * not become wrong, they would become unexplainable, which for a
   * lender is the worse of the two. Same call the customer records made:
   * withdraw it from use, keep what it did.
   *
   * From the operator's side nothing changes: the rule leaves the list
   * and stops firing.
   */
  retire(id: string, actorId?: string, changeNote?: string) {
    return this.repo.retire(id, { changedById: actorId, changeNote });
  }

  seedDefaults() {
    return this.repo.seedDefaults();
  }
}
