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
export function periodBounds(p: PeriodKey): { start: Date; endExclusive: Date } {
  const start = new Date(p.year, p.month - 1, 1);
  const endExclusive = new Date(p.year, p.month, 1);
  return { start, endExclusive };
}

/** "2026-05" — stable, sortable. */
export function keyOf(p: PeriodKey): string {
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
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
