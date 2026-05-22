import { type DecisionRuleRepository } from "@loan/db";

import type { CreateRuleInput, UpdateRuleInput } from "./schemas.js";

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

  async create(input: CreateRuleInput): Promise<CreateResult> {
    try {
      return { ok: true, rule: await this.repo.create(input) };
    } catch (err) {
      return { ok: false, kind: "Conflict", message: (err as Error).message };
    }
  }

  update(id: string, input: UpdateRuleInput) {
    return this.repo.update(id, input);
  }

  delete(id: string) {
    return this.repo.delete(id);
  }

  seedDefaults() {
    return this.repo.seedDefaults();
  }
}
