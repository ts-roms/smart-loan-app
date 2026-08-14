import { type AuditLogRepository, type EclRepository } from "@loan/db";
import { todayLocalISO } from "@loan/shared-utils";

import type { RunInput } from "./schemas";

/**
 * IFRS 9 / PFRS 9 expected-credit-loss orchestration.
 *
 * `run` defaults the period window (start = first-of-month of end,
 * end = today) and couples the repo write to an audit-log record
 * carrying the stage-bucket counts. The journal posting (DR
 * Impairment Expense, CR Allowance for Loan Losses) lives inside the
 * repo's `run` method — see libs/db/src/repositories/ecl.repository.ts.
 *
 * ── The window is a pair of DATES; `asOf` is the INSTANT ───────────────
 *
 * These are two different things and the defaulting used to conflate
 * them, with the period taking whatever instant the request happened to
 * arrive at.
 *
 * The window is an identity. `eclPeriodRef` renders it with
 * `toISOString().slice(0, 10)` to build the journal entry's idempotency
 * key, so anything below a day in `periodStart`/`periodEnd` is dropped —
 * but only after it has decided WHICH day. Defaulting `periodEnd` to an
 * instant therefore meant the key changed at UTC midnight: in Manila
 * (UTC+8) that is 08:00 local, so a run at 07:00 and a run at 09:00 on
 * one working day keyed to two different periods, `postIfAbsent` had
 * nothing to collide with, and the movement booked twice. That is the
 * double-post the period key was introduced to close, still open for
 * most of every local day.
 *
 * `asOf` is a measurement time. It feeds DPD → staging → every ECL
 * figure, and it is genuinely "now" for an on-demand run. So it is now
 * passed EXPLICITLY on the defaulting path, holding the instant that
 * `periodEnd` used to carry implicitly. The window became a date; the
 * as-of moment did not move, and no ECL figure moves with it.
 *
 * Both defaults are taken from the LOCAL calendar day and expressed as
 * UTC midnight. Local, because a lender's books close at local midnight,
 * not UTC midnight — the convention `todayLocalISO` and
 * `libs/accounting/src/periods.ts` already state. UTC midnight, because
 * that is the only construction `eclPeriodRef` renders back as the same
 * date it was built from. Local midnight would not: `new Date(2026, 7, 1)`
 * on a UTC+8 host is `2026-07-31T16:00:00Z`, so the old default keyed a
 * 1 August run as "2026-07-31" and keyed it differently again on a UTC
 * host. The key is immutable stored data; it should not depend on where
 * the process runs.
 *
 * An explicitly supplied window is left alone, including its `asOf`
 * fallback: asking for a period that closed in the past means asking to
 * be measured as of that period's end, which is what the repository
 * already does.
 */

/** UTC midnight on the calendar date `iso` ("YYYY-MM-DD"). */
function utcMidnight(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

/**
 * First of the month containing `end`, as UTC midnight.
 *
 * Read in UTC, deliberately: `end` here is an explicitly supplied
 * period end, which arrives as a date-only string and so is already UTC
 * midnight. Reading it with local getters instead would shift a
 * "2026-06-30" request back into May on any host east of UTC — the same
 * local/UTC seam that made the old default name the wrong month.
 */
function firstOfMonthUtc(end: Date): Date {
  return new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
}

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
    // The local calendar day the operator is standing in — the whole of
    // it maps to one window, so re-running at 07:00 and at 09:00 keys
    // the same period.
    const todayIso = todayLocalISO(now);
    const defaultedEnd = !args.input.periodEnd;
    const periodEnd = defaultedEnd
      ? utcMidnight(todayIso)
      : new Date(args.input.periodEnd!);
    const periodStart = args.input.periodStart
      ? new Date(args.input.periodStart)
      : defaultedEnd
        ? // First of the LOCAL month, taken from the same local date as
          // the end so a month boundary cannot split the two.
          utcMidnight(`${todayIso.slice(0, 8)}01`)
        : firstOfMonthUtc(periodEnd);

    const result = await this.repo.run({
      periodStart,
      periodEnd,
      /*
       * Only on the defaulting path, and only to hold still: `periodEnd`
       * used to be this instant and `EclRepository.run` fell back to it,
       * so passing it here keeps the as-of moment exactly where it was
       * while the window becomes a date. Leaving it out would silently
       * re-measure an on-demand run as of local midnight — a change to
       * DPD, staging and every ECL figure, smuggled in under a fix to an
       * idempotency key.
       *
       * An explicit window keeps the repository's own fallback
       * (asOf = periodEnd): a period requested by name is measured at
       * its end, not today.
       */
      asOf: defaultedEnd ? now : undefined,
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
