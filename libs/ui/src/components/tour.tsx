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
    return () => {
      driverRef.current?.destroy();
      driverRef.current = null;
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
    driverRef.current?.destroy();
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
