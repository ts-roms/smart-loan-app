import { useEffect, useState } from "react";

/**
 * Returns `value` after it has stopped changing for `delayMs`.
 *
 * Used to separate what the user is *typing* from what we're *querying*.
 * The input stays fully controlled and responsive on every keystroke;
 * only the debounced copy feeds the query key, so "dela cruz" costs one
 * request instead of nine.
 *
 * 300ms is the default because search-as-you-type wants to feel
 * immediate — the officer should see results settle as they finish the
 * word, not a beat later. The pre-decision preview in the loan wizard
 * uses 500ms for the opposite reason: it's a heavier call and firing it
 * mid-thought is wasteful.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
