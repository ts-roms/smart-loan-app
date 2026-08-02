/**
 * @loan/screening — AML / PEP / sanctions screening abstraction.
 *
 * Real providers (Refinitiv World-Check, ComplyAdvantage, Dow Jones) implement
 * `AmlProvider`. We ship a MockAmlProvider that consults a local watchlist
 * table — useful for dev and as a backstop for internally maintained lists.
 */

export interface ScreenInput {
  /** Customer's full name as captured on the application. */
  fullName: string;
  /** Optional: date of birth helps disambiguate hits. */
  dateOfBirth?: string;
  /** Optional: nationality. */
  countryCode?: string;
}

export interface MatchHit {
  /** Which list the match came from. */
  list: string;
  matchedName: string;
  /** 0..1 confidence. 1 = exact match. */
  score: number;
  /** Free-form context the officer needs for review. */
  reason?: string;
}

export type ScreenStatus = "PENDING" | "CLEAR" | "MATCH" | "REVIEW";

export interface ScreenResult {
  status: ScreenStatus;
  matches: MatchHit[];
  /** Provider's reference id for this screen. */
  providerRef?: string;
}

export interface AmlProvider {
  readonly name: string;
  screen(input: ScreenInput): Promise<ScreenResult>;
}

/**
 * Mock provider. Caller injects a local watchlist; we do a name + alias
 * substring match (case-insensitive). Exact full-name hits = MATCH, partial
 * hits = REVIEW.
 *
 * Real providers do fuzzy matching, transliteration, DOB filtering, etc.
 * The interface stays the same.
 */
export class MockAmlProvider implements AmlProvider {
  readonly name = "MOCK";

  constructor(
    private readonly loader: () => Promise<
      Array<{
        list: string;
        fullName: string;
        aliases: string[];
        reason: string | null;
      }>
    >,
  ) {}

  async screen(input: ScreenInput): Promise<ScreenResult> {
    const list = await this.loader();
    const subject = input.fullName.toLowerCase().trim();

    // An empty or whitespace-only name is unscreenable, not clean.
    //
    // Returning CLEAR would assert a negative we never established. And
    // falling through to the loop below is worse: `c.includes("")` is true
    // for every string, so an empty subject used to "match" every row on
    // the watchlist and hand the officer the entire list as hits.
    //
    // REVIEW with no matches keeps a human in the loop — which is also what
    // the old code effectively returned, minus the noise.
    if (!subject) {
      return { status: "REVIEW", matches: [] };
    }

    const matches: MatchHit[] = [];
    for (const row of list) {
      // Trim the candidates too, not just the subject. Watchlist rows are
      // imported from third-party files and routinely carry stray
      // whitespace; without this, " Juan Dela Cruz " never compares equal to
      // an exact hit, so it scored 0.7 and downgraded the result from MATCH
      // to REVIEW. Only MATCH trips the AML auto-reject, so a single padded
      // row was enough to stop a sanctions hit from blocking a loan.
      const candidates = [row.fullName, ...row.aliases].map((s) =>
        s.toLowerCase().trim(),
      );
      for (const c of candidates) {
        if (!c) continue;
        if (c === subject) {
          matches.push({
            list: row.list,
            matchedName: row.fullName,
            score: 1,
            reason: row.reason ?? undefined,
          });
          break;
        }
        if (c.includes(subject) || subject.includes(c)) {
          matches.push({
            list: row.list,
            matchedName: row.fullName,
            score: 0.7,
            reason: row.reason ?? undefined,
          });
          break;
        }
      }
    }
    if (matches.length === 0) return { status: "CLEAR", matches };
    if (matches.some((m) => m.score >= 1)) return { status: "MATCH", matches };
    return { status: "REVIEW", matches };
  }
}
