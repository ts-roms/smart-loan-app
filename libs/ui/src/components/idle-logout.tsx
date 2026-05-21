import { Clock, LogOut } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog";

/**
 * Idle-then-logout pair: the `useIdleLogout` hook tracks user activity
 * and exposes a single `warning` flag, and `IdleWarningDialog` renders
 * the countdown modal that decides between "Stay signed in" and forced
 * sign-out.
 *
 * Why these two pieces live together: the dialog's countdown needs to
 * call the hook's `extendSession` callback to reset the activity clock
 * when the user clicks Stay. Splitting them across files would mean
 * threading three or four callbacks through a wrapper — keeping them in
 * one module preserves a tight, testable surface.
 *
 * ─── Usage ─────────────────────────────────────────────────────────
 *
 *   const idle = useIdleLogout({
 *     idleSeconds: 60,
 *     warningSeconds: 60,
 *     enabled: !!user,
 *     onLogout: () => { signOut(); navigate('/login'); },
 *   });
 *
 *   <IdleWarningDialog state={idle} />
 *
 * ─── Activity detection ───────────────────────────────────────────
 *
 * The hook listens to a fixed set of "human present" events:
 *   • mousemove / mousedown
 *   • keydown
 *   • touchstart
 *   • scroll
 *   • visibilitychange  → when the tab regains focus we treat that as
 *                         activity (the user just came back from email)
 *
 * Events are throttled to once-per-second so we don't thrash setState
 * on every pixel of pointer travel. The activity clock lives in a ref
 * (no re-render) and is sampled by an interval that fires every 500ms;
 * when sample - lastActivity ≥ idleMs we flip into the warning phase.
 *
 * ─── Cross-tab note ───────────────────────────────────────────────
 *
 * Activity in *any* tab of this origin counts: we broadcast a
 * `localStorage.setItem` ping on every event, and other tabs listening
 * on `storage` reset their clocks. Without this an officer with two
 * tabs would get logged out of the background tab while still using
 * the other.
 */

export interface UseIdleLogoutOptions {
  /** Seconds of no activity before the warning fires. */
  idleSeconds: number;
  /** Countdown shown inside the warning before forced logout. */
  warningSeconds: number;
  /**
   * Master switch. Set false on pages that should never auto-logout
   * (signup, forgot-password) or when the user isn't signed in yet —
   * the hook short-circuits in that case.
   */
  enabled: boolean;
  /**
   * Called when the warning countdown reaches zero. The shell typically
   * calls signOut() + navigate to /login here.
   */
  onLogout: () => void;
}

export interface IdleLogoutState {
  /** True while the warning modal should be visible. */
  warning: boolean;
  /** Seconds left on the warning countdown. Counts down from `warningSeconds`. */
  remaining: number;
  /** Dismiss the warning, reset the idle clock. Used by the "Stay" button. */
  extend: () => void;
  /** Force-trigger the logout path (used by "Log out now" inside the dialog). */
  logoutNow: () => void;
  /** Mirror of options for the dialog title text. */
  warningSeconds: number;
}

const ACTIVITY_EVENTS = [
  "mousemove",
  "mousedown",
  "keydown",
  "touchstart",
  "scroll",
] as const;
const ACTIVITY_BROADCAST_KEY = "smartloan.idle.lastActivity.v1";
// Sample interval — short enough that the user doesn't see a 1-2s delay
// between actual idle moment and warning appearing.
const TICK_MS = 500;
// Throttle so we don't write to localStorage on every pixel of mouse
// travel.
const THROTTLE_MS = 1000;

export function useIdleLogout(opts: UseIdleLogoutOptions): IdleLogoutState {
  const { idleSeconds, warningSeconds, enabled, onLogout } = opts;

  // Mutable activity timestamp — lives in a ref so a mousemove doesn't
  // trigger a render. The interval below reads it.
  const lastActivityRef = useRef<number>(Date.now());
  // Throttle gate for the cross-tab broadcast.
  const lastBroadcastRef = useRef<number>(0);

  // Warning + countdown live in state because the dialog renders them.
  const [warning, setWarning] = useState(false);
  const [remaining, setRemaining] = useState(warningSeconds);

  // Pin the callback in a ref so the interval below doesn't need to
  // restart whenever the parent passes a fresh closure.
  const onLogoutRef = useRef(onLogout);
  useEffect(() => {
    onLogoutRef.current = onLogout;
  }, [onLogout]);

  const markActive = useCallback(() => {
    const now = Date.now();
    lastActivityRef.current = now;
    // If we're currently showing the warning, the user touching anything
    // doesn't auto-dismiss it — they explicitly chose to ignore the
    // dialog. They must click "Stay signed in" to extend. (Without this,
    // an accidental mousemove would silently extend the session and
    // defeat the security gate.)
    if (warning) return;
    // Cross-tab broadcast, throttled.
    if (now - lastBroadcastRef.current >= THROTTLE_MS) {
      lastBroadcastRef.current = now;
      try {
        window.localStorage.setItem(ACTIVITY_BROADCAST_KEY, String(now));
      } catch {
        /* private-mode / quota — ignore */
      }
    }
  }, [warning]);

  // Subscribe to DOM activity + cross-tab pings.
  useEffect(() => {
    if (!enabled) return;
    ACTIVITY_EVENTS.forEach((evt) =>
      window.addEventListener(evt, markActive, { passive: true }),
    );
    const onVisibility = () => {
      if (document.visibilityState === "visible") markActive();
    };
    document.addEventListener("visibilitychange", onVisibility);
    const onStorage = (e: StorageEvent) => {
      if (e.key === ACTIVITY_BROADCAST_KEY && e.newValue) {
        const ts = Number(e.newValue);
        if (Number.isFinite(ts)) lastActivityRef.current = ts;
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      ACTIVITY_EVENTS.forEach((evt) =>
        window.removeEventListener(evt, markActive),
      );
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("storage", onStorage);
    };
  }, [enabled, markActive]);

  // The sampling loop. One interval handles both:
  //   • "Have we been idle long enough to show the warning?" — flips the warning bit
  //   • "How many seconds left until logout?" — drives the countdown text
  useEffect(() => {
    if (!enabled) {
      setWarning(false);
      setRemaining(warningSeconds);
      return;
    }
    const idleMs = idleSeconds * 1000;
    const warningMs = warningSeconds * 1000;
    const handle = window.setInterval(() => {
      const since = Date.now() - lastActivityRef.current;
      if (!warning) {
        // Not yet warning — should we start?
        if (since >= idleMs) {
          setWarning(true);
          setRemaining(warningSeconds);
        }
      } else {
        // In warning phase — compute time left until forced logout.
        const left = Math.max(
          0,
          Math.ceil((idleMs + warningMs - since) / 1000),
        );
        setRemaining(left);
        if (left <= 0) {
          // Hit zero. Stop the interval before calling out so a re-entry
          // doesn't double-fire onLogout.
          window.clearInterval(handle);
          setWarning(false);
          onLogoutRef.current();
        }
      }
    }, TICK_MS);
    return () => window.clearInterval(handle);
  }, [enabled, idleSeconds, warningSeconds, warning]);

  const extend = useCallback(() => {
    lastActivityRef.current = Date.now();
    setWarning(false);
    setRemaining(warningSeconds);
    try {
      window.localStorage.setItem(ACTIVITY_BROADCAST_KEY, String(Date.now()));
    } catch {
      /* ignore */
    }
  }, [warningSeconds]);

  const logoutNow = useCallback(() => {
    setWarning(false);
    onLogoutRef.current();
  }, []);

  return { warning, remaining, extend, logoutNow, warningSeconds };
}

// ─── Dialog ──────────────────────────────────────────────────────────

/**
 * Modal companion to `useIdleLogout`. Shows the live countdown plus the
 * two action buttons. The Dialog uses our `open={false}` + close-on-
 * action pattern: it stays mounted but invisible until the hook flips
 * `warning` to true.
 *
 * UX choices:
 *   • The dialog is **non-dismissable** by Escape or backdrop click —
 *     hitting Escape would feel like "this dismissed itself" without
 *     making a real choice. The user must press Stay or Log out.
 *   • Stay signed in is the primary (sky) action — most users hitting
 *     the dialog want to keep going.
 *   • Log out now is destructive-tone to make it clear it ends the
 *     session immediately, not just on countdown end.
 */
export function IdleWarningDialog({ state }: { state: IdleLogoutState }) {
  return (
    <Dialog
      open={state.warning}
      onOpenChange={(o) => {
        if (!o) state.extend();
      }}
    >
      <DialogContent
        className="max-w-md"
        // Block dismiss via Escape / outside-click; the user must pick.
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-warning" />
            Are you still there?
          </DialogTitle>
          <DialogDescription>
            For your security, you'll be signed out automatically after a period
            of inactivity.
          </DialogDescription>
        </DialogHeader>

        {/* Big countdown — gives the user a sense of urgency without
            doom-scaring them. Color shifts to danger inside the last 10s. */}
        <div className="my-3 flex flex-col items-center gap-1.5">
          <div
            className={
              "tabular text-4xl font-semibold " +
              (state.remaining <= 10 ? "text-danger" : "text-fg")
            }
            role="timer"
            aria-live="polite"
          >
            {state.remaining}s
          </div>
          <div className="text-xs text-fg-muted">until automatic sign out</div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={state.logoutNow} className="gap-1.5">
            <LogOut className="h-3.5 w-3.5" />
            Log out now
          </Button>
          <Button onClick={state.extend} autoFocus>
            Stay signed in
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
