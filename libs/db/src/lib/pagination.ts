/**
 * Offset pagination for the list endpoints.
 *
 * ## Why offset rather than a cursor
 *
 * These lists back operator tables with filters and a page control:
 * "page 3 of 12", jump to the last page, tell me how many matched. A
 * cursor can't answer any of those without a separate count anyway, and
 * the tables are filtered down to hundreds of rows, not millions — the
 * usual argument for cursors (deep offsets getting slow) doesn't apply.
 *
 * The usual argument *against* offset does apply and is accepted: rows
 * inserted while an operator pages can shift the window. For a loan book
 * ordered by submission date that means a new application can push one
 * row from page 1 onto page 2. Nothing is lost, and the alternative
 * costs the page numbers these screens are built around.
 */

export interface PageParams {
  /** 1-indexed. Values below 1 are clamped rather than rejected. */
  page?: number;
  /** Rows per page. Clamped to the caller's maximum. */
  pageSize?: number;
}

export interface Page<T> {
  rows: T[];
  /** Total matching the filter, across all pages — not `rows.length`. */
  total: number;
  /** The page actually served, after clamping. */
  page: number;
  /** The page size actually used, after clamping. */
  pageSize: number;
  /**
   * At least 1, even when nothing matched, so a UI can render "Page 1 of
   * 1" over an empty table instead of "Page 1 of 0".
   */
  totalPages: number;
}

export interface PagingBounds {
  defaultPageSize: number;
  maxPageSize: number;
}

export interface ResolvedPaging {
  skip: number;
  take: number;
  page: number;
  pageSize: number;
}

/**
 * Normalize page params into Prisma's skip/take, clamping instead of
 * throwing.
 *
 * Clamping is deliberate: these values arrive from a query string, so a
 * bookmarked `?page=0` or a hand-edited `?pageSize=100000` is an ordinary
 * event, not an attack to be met with a 400. The caller gets the nearest
 * legal page and a `page`/`pageSize` echo telling them what they actually
 * got, so the UI can correct itself.
 */
export function resolvePaging(
  params: PageParams,
  bounds: PagingBounds,
): ResolvedPaging {
  const pageSize = clamp(
    Math.floor(params.pageSize ?? bounds.defaultPageSize),
    1,
    bounds.maxPageSize,
  );
  // Both bounds go through `clamp`, which is where the non-finite guard
  // lives. `Math.max(1, NaN)` is NaN, so hand-rolling the lower bound
  // here would leak a NaN `skip` straight into the query.
  const page = clamp(Math.floor(params.page ?? 1), 1, Number.MAX_SAFE_INTEGER);
  return { skip: (page - 1) * pageSize, take: pageSize, page, pageSize };
}

/**
 * Assemble the envelope from a query's rows and its count.
 *
 * A page past the end returns an empty `rows` with the real `total`
 * intact — the UI needs the count to work out where to send the operator
 * back to, and inventing a redirect to the last page here would mean
 * quietly serving a page nobody asked for.
 */
export function toPage<T>(
  rows: T[],
  total: number,
  resolved: ResolvedPaging,
): Page<T> {
  return { rows, ...pageMetaOf(total, resolved) };
}

/**
 * The envelope's counters, without the rows.
 *
 * For responses that are not *only* a row list. The aging report carries
 * whole-book band totals alongside its paginated `rows`, so it needs the
 * page counters merged into an existing object rather than an envelope
 * wrapped around one — and `total` there must keep meaning "how many
 * matched", not "how many are on this page", because a dashboard reads
 * it as the active-loan count.
 */
export function pageMetaOf(
  total: number,
  resolved: ResolvedPaging,
): Omit<Page<never>, "rows"> {
  return {
    total,
    page: resolved.page,
    pageSize: resolved.pageSize,
    totalPages: Math.max(1, Math.ceil(total / resolved.pageSize)),
  };
}

function clamp(value: number, min: number, max: number): number {
  // NaN survives Math.min/Math.max, and a NaN `take` makes Prisma throw
  // at the driver with an error nobody can trace back to a query string.
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}
