import { describe, expect, it } from "vitest";

import {
  HEARTBEAT_MS,
  MIN_ONLINE_WINDOW_MS,
  onlineWindowMs,
  presenceOf,
  shouldStampHeartbeat,
} from "./presence";

const NOW = 1_800_000_000_000;
const ago = (ms: number) => new Date(NOW - ms);

describe("shouldStampHeartbeat", () => {
  it("writes for a user who has never been seen", () => {
    expect(shouldStampHeartbeat(null, NOW)).toBe(true);
    expect(shouldStampHeartbeat(undefined, NOW)).toBe(true);
  });

  it("does not write again inside the interval", () => {
    expect(shouldStampHeartbeat(ago(HEARTBEAT_MS - 1), NOW)).toBe(false);
  });

  it("writes once the interval has elapsed", () => {
    expect(shouldStampHeartbeat(ago(HEARTBEAT_MS), NOW)).toBe(true);
    expect(shouldStampHeartbeat(ago(HEARTBEAT_MS + 1), NOW)).toBe(true);
  });

  /**
   * The throttle is the entire cost argument for putting this on the
   * request path. If it ever returned true for every call, a busy
   * officer would generate one UPDATE per request instead of one per
   * 30 seconds — so this pins the ratio rather than a single boolean.
   */
  it("collapses a burst of requests into one write per interval", () => {
    const burst = (requests: number, everyMs: number) => {
      let writes = 0;
      let lastSeen: Date | null = null;
      for (let i = 0; i < requests; i++) {
        const t = NOW + i * everyMs;
        if (shouldStampHeartbeat(lastSeen, t)) {
          writes++;
          lastSeen = new Date(t);
        }
      }
      return writes;
    };
    // 200 requests every 300ms spans 59.7s — the first write, then one
    // at 30s. The beat at 60s falls just past the end of the burst.
    expect(burst(200, 300)).toBe(2);
    // Push past 60s and the third arrives.
    expect(burst(202, 300)).toBe(3);
    // The ratio is the point: 200 requests, 2 writes.
    expect(burst(200, 300)).toBeLessThan(200 / 50);
  });

  it("treats an unparseable timestamp as stale", () => {
    // Failing to write is invisible; writing once too often costs nothing.
    expect(shouldStampHeartbeat("not-a-date", NOW)).toBe(true);
  });
});

describe("onlineWindowMs", () => {
  it("follows the org idle policy", () => {
    expect(onlineWindowMs(1800)).toBe(1800 * 1000 + 60_000);
  });

  /**
   * The default idle timeout is 60 SECONDS. Without the floor the
   * window would be 120s — which happens to equal the floor — but an
   * org tightening it to 15s would get a 75s window, only 2.5 beats
   * wide, and active users would blink offline between heartbeats.
   */
  it("never drops below the floor, whatever the policy says", () => {
    expect(onlineWindowMs(15)).toBe(MIN_ONLINE_WINDOW_MS);
    expect(onlineWindowMs(0)).toBe(MIN_ONLINE_WINDOW_MS);
  });

  it("always leaves room for at least one missed beat", () => {
    for (const timeout of [0, 15, 60, 300, 1800]) {
      expect(onlineWindowMs(timeout)).toBeGreaterThan(HEARTBEAT_MS * 2);
    }
  });
});

describe("presenceOf", () => {
  const W = onlineWindowMs(60); // 120s on the default policy

  it("separates never-seen from offline", () => {
    expect(presenceOf(null, NOW, W)).toBe("NEVER");
    expect(presenceOf(ago(W + 1), NOW, W)).toBe("OFFLINE");
  });

  it("counts someone seen inside the window as online", () => {
    expect(presenceOf(ago(0), NOW, W)).toBe("ONLINE");
    expect(presenceOf(ago(W), NOW, W)).toBe("ONLINE");
  });

  it("drops them the moment the window passes", () => {
    expect(presenceOf(ago(W + 1), NOW, W)).toBe("OFFLINE");
  });

  /**
   * The property that makes the whole design work: an ACTIVE user is
   * never shown as offline. Their heartbeat lags by up to HEARTBEAT_MS,
   * so the window has to cover that lag with room to spare.
   */
  it("never marks an actively-beating user offline", () => {
    expect(presenceOf(ago(HEARTBEAT_MS), NOW, W)).toBe("ONLINE");
    // Even having missed a beat entirely.
    expect(presenceOf(ago(HEARTBEAT_MS * 2), NOW, W)).toBe("ONLINE");
  });

  it("reads a future timestamp as online, not as absent", () => {
    // Clock skew between hosts. Evidence of very recent contact.
    expect(presenceOf(new Date(NOW + 5_000), NOW, W)).toBe("ONLINE");
  });

  it("goes offline on its own, with nothing having to clear it", () => {
    // The reason this is a timestamp and not a boolean: the process
    // that set it can die and the value still decays correctly.
    const seen = ago(0);
    expect(presenceOf(seen, NOW, W)).toBe("ONLINE");
    expect(presenceOf(seen, NOW + W + 1, W)).toBe("OFFLINE");
  });

  /*
   * The heartbeat can say "we heard from them 10 seconds ago". It
   * cannot say "and then we hung up". These are the cases where the
   * badge used to keep claiming Online right after an admin had cut
   * the account off — the one moment anyone is watching it closely.
   */
  describe("sessions that were ended, not merely idle", () => {
    it("reads offline once sessions are revoked after the last beat", () => {
      const seen = ago(10_000);
      expect(presenceOf(seen, NOW, W)).toBe("ONLINE");
      expect(presenceOf(seen, NOW, W, { sessionsRevokedAt: ago(5_000) })).toBe(
        "OFFLINE",
      );
    });

    it("lets a fresh sign-in beat an earlier revocation", () => {
      // Signed out at T-60s, signed back in and beating since T-5s.
      expect(
        presenceOf(ago(5_000), NOW, W, { sessionsRevokedAt: ago(60_000) }),
      ).toBe("ONLINE");
    });

    it("treats a revocation at the same instant as ending the session", () => {
      const t = ago(1_000);
      expect(presenceOf(t, NOW, W, { sessionsRevokedAt: t })).toBe("OFFLINE");
    });

    it("reads a deactivated account as offline however recent the beat", () => {
      expect(presenceOf(ago(0), NOW, W, { active: false })).toBe("OFFLINE");
    });

    it("still says NEVER for someone who never signed in", () => {
      // Deactivating a dormant account shouldn't promote it to
      // "offline", which would read as "was here once".
      expect(presenceOf(null, NOW, W, { active: false })).toBe("NEVER");
    });

    it("ignores an unparseable revocation rather than hiding a live user", () => {
      expect(
        presenceOf(ago(0), NOW, W, { sessionsRevokedAt: "not-a-date" }),
      ).toBe("ONLINE");
    });
  });
});
