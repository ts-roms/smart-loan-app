import { type AuditLogRepository, type EclRepository } from "@loan/db";

import type { RunInput } from "./schemas.js";

/**
 * IFRS 9 / PFRS 9 expected-credit-loss orchestration.
 *
 * `run` defaults the period window (start = first-of-month of end,
 * end = today) and couples the repo write to an audit-log record
 * carrying the stage-bucket counts. The journal posting (DR
 * Impairment Expense, CR Allowance for Loan Losses) lives inside the
 * repo's `run` method — see libs/db/src/repositories/ecl.repository.ts.
 */
export class EclService {
  constructor(
    private readonly repo: EclRepository,
    private readonly audit: AuditLogRepository,
  ) {}

  list() {
    return this.repo.list();
  }

  async run(args: { input: RunInput; actorId: string }) {
    const now = new Date();
    const periodEnd = args.input.periodEnd
      ? new Date(args.input.periodEnd)
      : now;
    const periodStart = args.input.periodStart
      ? new Date(args.input.periodStart)
      : new Date(periodEnd.getFullYear(), periodEnd.getMonth(), 1);

    const result = await this.repo.run({
      periodStart,
      periodEnd,
      computedById: args.actorId,
      notes: args.input.notes,
    });

    await this.audit.record({
      action: "ECL_RUN",
      actorId: args.actorId,
      targetType: "EclRun",
      targetId: result.id,
      payload: {
        totalEcl: result.totalEcl,
        stages: {
          STAGE_1: result.byStage.STAGE_1.count,
          STAGE_2: result.byStage.STAGE_2.count,
          STAGE_3: result.byStage.STAGE_3.count,
        },
      },
    });
    return result;
  }
}
