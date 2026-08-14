/**
 * Bounded walks over a whole-book read.
 *
 * ## What this is for, and what it deliberately is not
 *
 * Three reports have to look at every row that matches their filter,
 * because what they produce is an AGGREGATE: aging band totals, a
 * roll-rate matrix, a globally ranked collections queue. A total cannot
 * be computed from a page — that is not a limitation of the
 * implementation, it is what "total" means. So `take`/`skip` on the
 * source query is not available to them, and finding F4 in
 * docs/modernization/query-performance.md is not, at root, a request to
 * put one there.
 *
 * What IS available is bounding how much of the book is resident in Node
 * at once. The old shape asked Postgres for every matching row, waited,
 * and hydrated the lot into Prisma objects before the first line of
 * arithmetic ran — 1.3M `LoanSchedule` rows at the volume the doc
 * measured. This walks the same rows in fixed-size chunks and folds each
 * chunk into an accumulator before asking for the next, so peak
 * hydration is the chunk, not the book.
 *
 * The set of rows visited is identical, and so is every number derived
 * from it. That is the property the golden tests police.
 *
 * ## Why keyset (`cursor`) and not `skip`
 *
 * This is the one place in this repository that does NOT use the offset
 * helper in `pagination.ts`, and the reason is specific rather than
 * fashionable. `skip: n` makes Postgres walk and discard n rows on every
 * call, so a full pass over N rows in pages of C costs O(N²/C) row
 * visits — the deep-offset problem the customer-list caveat in the query
 * doc already records at `OFFSET 20000`. A cursor on the primary key
 * resumes exactly where the last chunk stopped, so a full pass stays
 * O(N).
 *
 * Offset paging remains correct and preferred for the operator tables it
 * was written for, where the user jumps to page 7 of 12 and never walks
 * the whole set. These walks always visit everything, which is the case
 * it is worst at.
 *
 * ## Ordering
 *
 * Chunking requires a total order, so these queries acquire
 * `orderBy: { id: "asc" }` where they previously had none. That is a
 * tightening, not a change: an unordered `findMany` returns rows in
 * whatever physical order the scan produced, so nothing could have
 * depended on the old order. All three folds are order-insensitive
 * anyway — they group into maps keyed by loan or by matrix cell, and the
 * per-step `round2` operates on exact 2-decimal values, where float
 * addition is exact well past any book this system will hold.
 */

/** Rows per round trip. */
export const BOOK_CHUNK_SIZE = 2_000;

/**
 * Walk every row matching a query, `chunkSize` at a time, folding as we
 * go.
 *
 * `fetch` is handed the id to resume after (`null` on the first call) and
 * must apply `orderBy: { id: "asc" }`, `take`, and — when the cursor is
 * non-null — `cursor: { id }` with `skip: 1`. It is written as a callback
 * rather than as a generic query builder because the three callers select
 * very different shapes, and a builder that could express all three would
 * be harder to read than the three `findMany` calls it replaced.
 *
 * The loop stops on a short chunk. A chunk that comes back exactly full
 * costs one extra empty round trip, which is the correct trade: the
 * alternative is a `count` before the walk, which is a second full scan
 * to save one index probe.
 */
export async function forEachBookChunk<T extends { id: string }>(
  fetch: (resumeAfterId: string | null, take: number) => Promise<T[]>,
  onChunk: (rows: T[]) => void,
  chunkSize: number = BOOK_CHUNK_SIZE,
): Promise<void> {
  let resumeAfterId: string | null = null;
  for (;;) {
    const rows = await fetch(resumeAfterId, chunkSize);
    if (rows.length === 0) return;
    onChunk(rows);
    if (rows.length < chunkSize) return;
    resumeAfterId = rows[rows.length - 1]!.id;
  }
}

/**
 * The `cursor`/`skip` half of a chunked `findMany`, spread into the query.
 *
 * Prisma's `cursor` is INCLUSIVE of the row it names, so resuming needs
 * `skip: 1` alongside it. Getting that wrong re-folds one row per chunk —
 * a duplicate that would inflate a band total by a few hundred pesos per
 * chunk and look like a rounding fault rather than a bug. Kept in one
 * place so all three callers get it right by construction.
 */
export function resumeAfter(id: string | null): {
  cursor?: { id: string };
  skip?: number;
} {
  return id === null ? {} : { cursor: { id }, skip: 1 };
}
