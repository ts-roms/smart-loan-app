import { z } from "zod";

/**
 * ECL run request. Both period fields default in the service:
 *   periodEnd → today
 *   periodStart → first-of-month of periodEnd
 *
 * Letting the service own the defaults means a future migration to a
 * fiscal calendar (e.g. period starts on the 26th) doesn't touch the
 * wire format.
 */
export const runSchema = z.object({
  periodStart: z.string().optional(),
  periodEnd: z.string().optional(),
  notes: z.string().max(500).optional(),
});
export type RunInput = z.infer<typeof runSchema>;

/* ─── Responses ────────────────────────────────────────────────────────
 *
 * These two operations disagree about how money is typed, and the
 * disagreement is real rather than an oversight — so read the note on
 * each before copying one into the other.
 */

/**
 * One stored ECL run. **Every money field is a STRING.**
 *
 * `GET /ecl/runs` returns Prisma rows straight from `findMany` with no
 * projection, so the `Decimal(18,2)` columns reach `JSON.stringify` as
 * decimal.js objects and serialise via their `toJSON` — which emits
 * `"125000.00"`, not `125000`. Declaring these as `z.number()` would
 * not merely mis-document them: fast-json-stringify would try to coerce
 * the Decimal OBJECT to a number and write garbage into the response.
 *
 * The counts are genuine `Int` columns and stay numbers.
 */
export const eclRunResponseSchema = z.object({
  id: z.string().uuid(),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  asOf: z.string().datetime(),
  /** Exposure at default, exact decimal string — e.g. "1250000.00". */
  totalEad: z.string(),
  /** Expected credit loss, exact decimal string. */
  totalEcl: z.string(),
  stage1Count: z.number().int(),
  stage2Count: z.number().int(),
  stage3Count: z.number().int(),
  stage1Ecl: z.string(),
  stage2Ecl: z.string(),
  stage3Ecl: z.string(),
  /**
   * The provision entry THIS run posted. Null when the delta was zero,
   * and also null on a re-run of a window an earlier run already booked
   * — that run holds the link, and duplicating it here would make the
   * one movement look like two.
   */
  journalEntryId: z.string().uuid().nullable(),
  computedById: z.string().uuid().nullable(),
  notes: z.string().nullable(),
});

/** `GET /ecl/runs` — history, newest period first, capped at 60. */
export const eclRunListResponseSchema = z.array(eclRunResponseSchema);

/**
 * The result of recomputing ECL. **Money here is a NUMBER, not a string.**
 *
 * The deliberate opposite of `eclRunResponseSchema` above, and worth
 * stating plainly because the two describe the same quantities. This
 * payload is assembled in the repository as plain JavaScript — every
 * figure is rounded with `.toFixed(2)` and coerced back with `+` before
 * it is returned — so no `Decimal` ever reaches the serialiser on this
 * route. Declaring these as strings would be as wrong as declaring the
 * stored row's fields as numbers.
 *
 * `byStage` always carries all three keys, zeroed when a stage is
 * empty. `perLoan` can be an empty array. `journalEntryId` is null when
 * the delta rounded to zero — there was nothing to post.
 */
export const eclRunResultResponseSchema = z.object({
  /** The EclRun row this created. */
  id: z.string().uuid(),
  totalEad: z.number(),
  totalEcl: z.number(),
  byStage: z.object({
    STAGE_1: z.object({ count: z.number().int(), ecl: z.number() }),
    STAGE_2: z.object({ count: z.number().int(), ecl: z.number() }),
    STAGE_3: z.object({ count: z.number().int(), ecl: z.number() }),
  }),
  perLoan: z.array(
    z.object({
      loanId: z.string().uuid(),
      /** Human loan number, e.g. "LN-2026-000006". */
      number: z.string(),
      /** Days past due. */
      dpd: z.number().int(),
      stage: z.enum(["STAGE_1", "STAGE_2", "STAGE_3"]),
      ead: z.number(),
      ecl: z.number(),
    }),
  ),
  /** Signed movement against the previous run. Positive = provision built. */
  delta: z.number(),
  /**
   * The entry carrying this PERIOD's movement — posted by this run, or
   * found already posted by an earlier one. Null when `delta` rounded to
   * zero, or no actor was recorded. Read it together with `posting`.
   */
  journalEntryId: z.string().uuid().nullable(),
  /**
   * What this run did to the ledger.
   *
   * `ALREADY_POSTED` means the window was booked before and this run
   * added no second entry — the recomputed stages and per-loan
   * provisions are still saved. A period's movement is posted once;
   * restating a booked period means reversing `journalEntryId` first
   * (§12). Callers that render "posted" off a non-null `journalEntryId`
   * alone will report a second booking that did not happen.
   */
  posting: z.enum([
    "POSTED",
    "ALREADY_POSTED",
    "NO_MOVEMENT",
    "NOT_ATTRIBUTED",
  ]),
});
