/**
 * Presence — "is this person online right now".
 *
 * Two pure functions and two constants, kept here because the API
 * writes the heartbeat and both the API and the web app read it, and
 * because these are exactly the kind of off-by-one that silently
 * mislabels every user in the list rather than throwing.
 *
 * The model is a decaying timestamp, not a stored flag. `User.lastSeenAt`
 * is stamped on authenticated requests and presence is derived at read
 * time. A boolean would have no way to become false — a crashed API
 * process, a closed laptop and dead wifi all leave it stuck on "online",
 * because the event that would clear it is precisely the event that
 * didn't happen.
 */

/**
 * How often a user's heartbeat may be written, at most.
 *
 * The throttle is the whole reason this is cheap: without it, a busy
 * officer costs one UPDATE per request. With it, one per 30 seconds no
 * matter how hard they use the app.
 *
 * 30s rather than 60s because it has to stay comfortably under the
 * online window below — the window is what decides whether an ACTIVE
 * user reads as online, and it can only be as precise as the heartbeat
 * that feeds it.
 */
export const HEARTBEAT_MS = 30_000;

/**
 * Floor for the online window.
 *
 * An org can set `idleTimeoutSeconds` to anything, including values
 * below the heartbeat interval. A window at or under the measurement
 * granularity is incoherent — an active user would drop out of it
 * between beats — so it never goes below 2 minutes.
 */
export const MIN_ONLINE_WINDOW_MS = 120_000;

/** Extra room on top of the idle timeout, for the beat still in flight. */
const GRACE_MS = 60_000;

/**
 * Should we write a heartbeat for this user right now?
 *
 * Null means they have never been seen, which always writes.
 */
export function shouldStampHeartbeat(
  lastSeenAt: Date | string | null | undefined,
  nowMs: number,
): boolean {
  if (!lastSeenAt) return true;
  const then = new Date(lastSeenAt).getTime();
  // An unparseable value is treated as stale rather than fresh: failing
  // to write is invisible, and writing once too often costs nothing.
  if (!Number.isFinite(then)) return true;
  return nowMs - then >= HEARTBEAT_MS;
}

/**
 * How recently someone must have been seen to count as online.
 *
 * Derived from the org's idle policy rather than fixed, because that
 * policy is what decides how long a real session can sit quiet. With
 * the default 60s timeout a user idle for two minutes has already been
 * signed out by the shell, and showing them as online would be a claim
 * the app itself has disproved.
 */
export function onlineWindowMs(idleTimeoutSeconds: number): number {
  const fromPolicy = idleTimeoutSeconds * 1000 + GRACE_MS;
  return Math.max(fromPolicy, MIN_ONLINE_WINDOW_MS);
}

/**
 * NEVER is kept apart from OFFLINE on purpose. "Has not signed in since
 * we started counting" and "was here this morning" are different facts
 * about a person, and collapsing them would quietly turn a dormant
 * account into one that merely looks idle.
 */
export type Presence = "ONLINE" | "OFFLINE" | "NEVER";

export function presenceOf(
  lastSeenAt: Date | string | null | undefined,
  nowMs: number,
  windowMs: number,
  /**
   * State that ENDS presence regardless of the heartbeat.
   *
   * A decaying timestamp can only answer "did we hear from them
   * recently". It cannot know that we hung up. An admin who signed
   * someone out watched them keep reading "Online" for the rest of the
   * window — the one moment the badge is being checked closely, and
   * the one moment it was wrong. Same for a deactivated account.
   *
   * `sessionsRevokedAt` beats `lastSeenAt` only when it is the LATER
   * of the two: sign back in after a revoke and the fresh heartbeat
   * wins, which is exactly right.
   */
  ended?: {
    sessionsRevokedAt?: Date | string | null;
    active?: boolean;
  },
): Presence {
  if (!lastSeenAt) return "NEVER";
  const then = new Date(lastSeenAt).getTime();
  if (!Number.isFinite(then)) return "NEVER";

  // Disabled accounts cannot hold a session. Keep the "was here once"
  // fact — NEVER above still wins for someone who never signed in.
  if (ended?.active === false) return "OFFLINE";

  if (ended?.sessionsRevokedAt) {
    const cut = new Date(ended.sessionsRevokedAt).getTime();
    if (Number.isFinite(cut) && cut >= then) return "OFFLINE";
  }

  // Clock skew, or a row written by a host running slightly ahead.
  // A future timestamp is evidence of very recent contact, not of
  // absence, so it reads as online rather than falling through.
  if (then > nowMs) return "ONLINE";
  return nowMs - then <= windowMs ? "ONLINE" : "OFFLINE";
}
