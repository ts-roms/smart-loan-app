/**
 * Period helpers. The general ledger groups journal entries into
 * monthly accounting periods. Each period can be OPEN (postings allowed)
 * or CLOSED (postings refused; reopen first).
 *
 * Year-end close is just the same as closing December.
 */

export interface PeriodKey {
  year: number;
  /** 1..12 */
  month: number;
}

export function periodFor(date: Date): PeriodKey {
  return { year: date.getFullYear(), month: date.getMonth() + 1 };
}

export function currentPeriod(): PeriodKey {
  return periodFor(new Date());
}

/** Inclusive-exclusive boundary dates for a period. */
export function periodBounds(p: PeriodKey): {
  start: Date;
  endExclusive: Date;
} {
  const start = new Date(p.year, p.month - 1, 1);
  const endExclusive = new Date(p.year, p.month, 1);
  return { start, endExclusive };
}

/** "2026-05" — stable, sortable. */
export function keyOf(p: PeriodKey): string {
  return `${p.year}-${String(p.month).padStart(2, "0")}`;
}

export function compare(a: PeriodKey, b: PeriodKey): number {
  if (a.year !== b.year) return a.year - b.year;
  return a.month - b.month;
}

/** Returns the previous month. Wraps Dec→Jan correctly. */
export function previous(p: PeriodKey): PeriodKey {
  if (p.month === 1) return { year: p.year - 1, month: 12 };
  return { year: p.year, month: p.month - 1 };
}

// ─── Day boundaries for report parameters ───────────────────────────────

/**
 * A calendar day is not an instant, and reports keep being asked for one.
 *
 * "Trial balance as of 2026-08-07" means "everything through the END of
 * the 7th". Handing that string to `new Date()` gives UTC midnight — the
 * FIRST instant of the day, and in Manila (UTC+8) that is 8am local, so
 * a report explicitly asked for as-of-today silently dropped the whole
 * working day that produced it. Measured on this repo's own fixtures:
 * ₱15,668.78 of entries missing from an as-of-today trial balance.
 *
 * The date-only shape is what makes this decidable. A caller who sends a
 * full timestamp means that instant and gets it back untouched; only
 * "YYYY-MM-DD" is widened, because only that shape is ambiguous.
 *
 * Local time, deliberately, matching `periodBounds` above — a coop's
 * books close at local midnight, not at UTC midnight.
 */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parseParts(value: string): [number, number, number] {
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  return [y, m, d];
}

/** First instant of the day, local. Use for an inclusive `from`. */
export function startOfDay(value: string | Date): Date {
  if (value instanceof Date) return value;
  if (!DATE_ONLY.test(value)) return new Date(value);
  const [y, m, d] = parseParts(value);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

/**
 * Last instant of the day, local. Use for an inclusive `to` / `asOf`.
 *
 * 23:59:59.999 rather than the next midnight because every caller
 * compares with `lte`. An exclusive upper bound would be cleaner in the
 * abstract and would silently include the next day's first millisecond
 * through every `lte` in the codebase.
 */
export function endOfDay(value: string | Date): Date {
  if (value instanceof Date) return value;
  if (!DATE_ONLY.test(value)) return new Date(value);
  const [y, m, d] = parseParts(value);
  return new Date(y, m - 1, d, 23, 59, 59, 999);
}
