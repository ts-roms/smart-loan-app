/**
 * Pure helpers for the DORSI compliance feature (FRD §3.10).
 *
 * Lives in libs/db/src/lib/ rather than the repository so it can be
 * unit-tested without standing up Prisma or seeding a DB. The repo
 * imports from here and adds the persistence shell.
 *
 * Two concerns covered:
 *   • Cap math — aggregate cap (15% of company equity) and individual
 *     cap (30% of aggregate). Single source of truth for these rates.
 *   • Name screening — fuzzy match against a list of active DORSI
 *     records, used at customer onboarding + loan creation per
 *     FRD §3.10.1.
 */

export const AGGREGATE_CAP_RATE = 0.15;
export const INDIVIDUAL_CAP_RATE = 0.3;

/** Two-decimal rounding shared across the helpers. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface DorsiCaps {
  aggregateCap: number;
  individualCap: number;
}

/**
 * Compute aggregate + individual caps from the company total equity.
 *   aggregateCap   = 15% of equity
 *   individualCap  = 30% of aggregate cap (= 4.5% of equity)
 *
 * Returns zeros when equity is zero/negative — the repo treats that
 * as "no DORSI loans allowed" downstream.
 */
export function computeCaps(companyTotalEquity: number): DorsiCaps {
  const equity = Math.max(0, companyTotalEquity);
  const aggregateCap = round2(equity * AGGREGATE_CAP_RATE);
  const individualCap = round2(aggregateCap * INDIVIDUAL_CAP_RATE);
  return { aggregateCap, individualCap };
}

/**
 * Normalize a name for fuzzy matching: lowercase, strip diacritics
 * (NFD + combining marks), strip punctuation, split on whitespace.
 * Drops single-letter tokens to avoid spurious 1-character matches
 * (common middle-initial pattern in PH names).
 */
export function tokenize(name: string): string[] {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

/**
 * Compare a candidate name's tokens against a DORSI record's tokens.
 * Returns a similarity score in {1.0, 0.85, 0.5, 0} plus the reason
 * the UI surfaces alongside the match.
 *
 *   1.0  Exact full-name match (same tokens, same order)
 *   0.85 Token subset (every candidate token is in the record, or vice
 *        versa, with at least 2 tokens overlapping)
 *   0.5  Family-name only (last token matches, both ≥ 3 chars)
 *   0    No match worth reporting
 */
export interface NameMatchScore {
  similarity: number;
  reason: string | null;
}

export function scoreNameMatch(
  candidateTokens: string[],
  recordTokens: string[],
): NameMatchScore {
  if (candidateTokens.length === 0 || recordTokens.length === 0) {
    return { similarity: 0, reason: null };
  }

  // Exact full-name match (same tokens, same order).
  if (
    candidateTokens.length === recordTokens.length &&
    candidateTokens.every((t, i) => t === recordTokens[i])
  ) {
    return { similarity: 1.0, reason: "Exact name match" };
  }

  // Token subset match (every token of the smaller set is in the larger).
  const cSet = new Set(candidateTokens);
  const dSet = new Set(recordTokens);
  const intersect = [...cSet].filter((t) => dSet.has(t)).length;
  const smallerCount = Math.min(cSet.size, dSet.size);
  if (smallerCount > 0 && intersect === smallerCount && intersect >= 2) {
    return {
      similarity: 0.85,
      reason: `Token subset match (${intersect} of ${smallerCount} tokens)`,
    };
  }

  // Family-name match — both have ≥ 3 chars on the last token, same string.
  const candidateLast = candidateTokens[candidateTokens.length - 1];
  const recordLast = recordTokens[recordTokens.length - 1];
  if (
    candidateLast &&
    recordLast &&
    candidateLast.length >= 3 &&
    candidateLast === recordLast
  ) {
    return {
      similarity: 0.5,
      reason: `Family-name match: ${candidateLast}`,
    };
  }

  return { similarity: 0, reason: null };
}
