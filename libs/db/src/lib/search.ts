/**
 * Free-text search helpers for the list endpoints.
 *
 * ## Why tokens rather than one `contains`
 *
 * Operators type what they remember, in the order they remember it:
 * "dela cruz", "juan cruz", "cruz LN-2026". A single `contains` over a
 * single column can't serve any of those — "juan cruz" is not a substring
 * of `firstName` or of `lastName`, and no column holds the concatenation.
 *
 * So each whitespace-separated token has to match *somewhere* on the row,
 * and every token has to match: AND-of-ORs. "juan cruz" then means
 * (any field ~ "juan") AND (any field ~ "cruz"), which finds Juan Dela
 * Cruz whichever order the operator typed it in, and doesn't also return
 * every other Juan.
 *
 * Tokens are capped (see MAX_TOKENS) because each one adds a full OR
 * branch to the query — a pasted paragraph shouldn't turn into a
 * hundred-clause scan.
 */

/**
 * Longer than any real search and generous for a pasted reference
 * number. Beyond this the extra text is noise, so it's dropped rather
 * than turned into query load.
 */
const MAX_TOKENS = 6;

/**
 * Normalize a raw query into search tokens: trimmed, lower-cased,
 * de-duplicated, capped. Returns an empty array for anything that isn't
 * worth searching on, which callers read as "no filter".
 *
 * Lower-casing here is for de-duplication only — the actual comparison is
 * done by Postgres with `mode: "insensitive"`.
 */
export function searchTokens(query: string | undefined | null): string[] {
  if (!query) return [];
  const seen = new Set<string>();
  for (const raw of query.trim().split(/\s+/)) {
    const token = raw.toLowerCase();
    // Single characters match nearly every row — the cost of running them
    // is real and the result is useless.
    if (token.length < 2) continue;
    seen.add(token);
    if (seen.size >= MAX_TOKENS) break;
  }
  return [...seen];
}

/**
 * Build the AND-of-ORs clause described above.
 *
 * `buildOr` receives one token and returns the Prisma conditions that
 * token could satisfy — the caller owns those shapes, so a condition can
 * reach through a relation (`{ customer: { lastName: { contains } } }`)
 * just as easily as a scalar column.
 *
 * Returns `undefined` when there's nothing to search on, so it can be
 * spread into a `where` without the caller branching:
 *
 *   where: { ...(searchWhere(q, orsFor) ?? {}) }
 */
export function tokenizedWhere<T>(
  query: string | undefined | null,
  buildOr: (token: string) => T[],
): { AND: Array<{ OR: T[] }> } | undefined {
  const tokens = searchTokens(query);
  if (tokens.length === 0) return undefined;
  return { AND: tokens.map((token) => ({ OR: buildOr(token) })) };
}

/**
 * Shorthand for the case-insensitive substring match every caller wants.
 * Kept here so the `mode` flag isn't repeated at two dozen call sites and
 * can't be forgotten at one of them.
 */
export function contains(token: string) {
  return { contains: token, mode: "insensitive" as const };
}
