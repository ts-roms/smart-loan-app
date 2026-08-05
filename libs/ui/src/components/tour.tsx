/**
 * Interactive tour primitive — wraps driver.js.
 *
 * Usage on a page:
 *
 *   const tour = useTour('loans-list', [
 *     { element: '[data-tour="new-loan-btn"]', popover: { title: 'New application', description: '…' } },
 *     { element: '[data-tour="loans-table"]', popover: { title: 'All loans', description: '…' } },
 *   ]);
 *   return (
 *     <>
 *       <Button onClick={tour.start}>Take a tour</Button>
 *       {tour.completed && <span>Tour done — click to replay</span>}
 *     </>
 *   );
 *
 * Mark UI elements with `data-tour="<key>"` matching the step selectors.
 * Tour completion is remembered in localStorage so we don't re-prompt
 * users who've already done it.
 */

import { driver, type Config, type DriveStep } from "driver.js";
import { useCallback, useEffect, useRef, useState } from "react";
import "driver.js/dist/driver.css";

const STORAGE_PREFIX = "loan.tour.";

/**
 * Force-remove any driver.js DOM that outlived its instance.
 *
 * driver.js appends its overlay (a document-sized SVG) and popover
 * straight to `<body>` — outside the app's h-screen shell. `destroy()`
 * is supposed to remove them, but when it runs mid-transition — exactly
 * what happens when a user clicks a link inside the highlighted element
 * and navigation unmounts the page — the removal can be lost, and the
 * stranded overlay keeps its document-sized height. The shell stays
 * pinned to the viewport, so the page grows a second (body-level)
 * scrollbar with a huge dead region below the content.
 *
 * The selectors and body classes below are driver.js 1.8's own
 * (`.driver-overlay`, `.driver-popover`, `driver-active driver-fade
 * driver-simple driver-no-interaction`). Removing them when no tour is
 * running is always safe: this DOM has no state worth preserving.
 */
export function sweepDriverResidue() {
  if (typeof document === "undefined") return;
  document
    .querySelectorAll(".driver-overlay, .driver-popover")
    .forEach((el) => el.remove());
  document.body.classList.remove(
    "driver-active",
    "driver-fade",
    "driver-simple",
    "driver-no-interaction",
  );
}

export interface UseTourResult {
  /** True if the user has already finished this tour in the past. */
  completed: boolean;
  /** Start the tour (or restart, if previously completed). */
  start: () => void;
  /** Forget the completion state so the user can take it again. */
  reset: () => void;
}

/**
 * Wire a tour against a list of steps. `tourId` is the localStorage key
 * suffix; pick something stable per page (e.g. `'loans-list'`).
 */
export function useTour(
  tourId: string,
  steps: DriveStep[],
  options?: Partial<Config>,
): UseTourResult {
  const key = STORAGE_PREFIX + tourId;
  const [completed, setCompleted] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(key) === "done";
  });

  // Cache the driver instance per-render to avoid double-init in StrictMode.
  const driverRef = useRef<ReturnType<typeof driver> | null>(null);

  useEffect(() => {
    // A page mounting is also the moment to clear any overlay a
    // *previous* page's tour stranded — that page's cleanup already ran
    // and failed, so nobody else is left to do it.
    sweepDriverResidue();
    return () => {
      // destroy() can throw when it races its own transition (the same
      // race that strands the overlay). Swallow it so the sweep below
      // always runs — the sweep is the part that actually guarantees a
      // clean <body>.
      try {
        driverRef.current?.destroy();
      } catch {
        // fall through to the sweep
      }
      driverRef.current = null;
      sweepDriverResidue();
    };
  }, []);

  const markComplete = useCallback(() => {
    try {
      localStorage.setItem(key, "done");
      setCompleted(true);
    } catch {
      // localStorage can throw in private mode — best-effort.
    }
  }, [key]);

  const start = useCallback(() => {
    try {
      driverRef.current?.destroy();
    } catch {
      // ignore — the sweep handles whatever destroy left behind
    }
    // Restarting over a stranded overlay would stack a second one on
    // top; start from a clean floor.
    sweepDriverResidue();
    const d = driver({
      showProgress: true,
      animate: true,
      smoothScroll: true,
      // Brand colours — match the rest of our UI's sky-300 highlight.
      popoverClass: "loan-tour-popover",
      onDestroyed: () => {
        markComplete();
      },
      steps,
      ...options,
    });
    driverRef.current = d;
    d.drive();
  }, [steps, options, markComplete]);

  const reset = useCallback(() => {
    try {
      localStorage.removeItem(key);
      setCompleted(false);
    } catch {
      // ignore
    }
  }, [key]);

  return { completed, start, reset };
}

/** Convenience type re-export so feature code doesn't import from driver.js directly. */
export type TourStep = DriveStep;
