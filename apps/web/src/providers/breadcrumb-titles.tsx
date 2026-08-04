import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useLocation } from "react-router-dom";

/**
 * Human labels for breadcrumb segments that a URL can't supply.
 *
 * `/customers/c7f3a91b` should read "Juan dela Cruz", not the id — but
 * only the page that loaded the record knows the name. So detail pages
 * publish their title here and <Breadcrumbs /> reads it back.
 *
 * Keyed by the exact pathname the title belongs to, NOT by the record
 * id. Two different routes can render the same record (a loan appears
 * under both /loans/:id and /portal/loans/:id) and they don't
 * necessarily want the same label.
 */
interface CrumbTitles {
  titles: Readonly<Record<string, string>>;
  publish: (path: string, label: string) => void;
}

const CrumbTitleContext = createContext<CrumbTitles | null>(null);

/*
 * Entries deliberately OUTLIVE the page that published them.
 *
 * Navigating /customers → /customers/:id → /customers/:id/survey leaves
 * the survey page rendering a trail whose middle crumb belongs to a
 * page that has already unmounted. Clearing on unmount would blank that
 * crumb at exactly the moment it's needed. A borrower's name doesn't
 * change mid-session, so a stale entry is not a correctness problem.
 *
 * The cost is a map that only grows, so it's capped — a user who opens
 * 200 customers in one sitting shouldn't accumulate 200 strings. Oldest
 * insertion is evicted first; JS objects keep insertion order for
 * non-numeric keys, and every key here starts with "/".
 */
const MAX_TITLES = 50;

export function BreadcrumbTitleProvider({ children }: { children: ReactNode }) {
  const [titles, setTitles] = useState<Record<string, string>>({});

  const publish = useCallback((path: string, label: string) => {
    setTitles((curr) => {
      // Bail before setting state when nothing changed, or every render
      // of a detail page would queue another one.
      if (curr[path] === label) return curr;
      const next = { ...curr, [path]: label };
      const keys = Object.keys(next);
      if (keys.length > MAX_TITLES) {
        for (const stale of keys.slice(0, keys.length - MAX_TITLES)) {
          delete next[stale];
        }
      }
      return next;
    });
  }, []);

  const value = useMemo(() => ({ titles, publish }), [titles, publish]);

  return (
    <CrumbTitleContext.Provider value={value}>
      {children}
    </CrumbTitleContext.Provider>
  );
}

/**
 * Name the current route in the breadcrumb trail.
 *
 * Call from a detail page with whatever the user would call the record:
 *
 *   useCrumbTitle(customer.data ? fullName(customer.data) : null);
 *
 * Pass null/undefined while loading — the trail falls back to the raw
 * URL segment until the real label arrives, so it never flashes empty.
 */
export function useCrumbTitle(label: string | null | undefined): void {
  const ctx = useContext(CrumbTitleContext);
  const { pathname } = useLocation();
  const publish = ctx?.publish;

  useEffect(() => {
    if (label && publish) publish(pathname, label);
  }, [label, pathname, publish]);
}

/**
 * Published titles, for <Breadcrumbs />. Returns an empty map when no
 * provider is mounted so the trail degrades to raw URL segments rather
 * than throwing — the shells are also rendered in isolation by tests.
 */
export function useCrumbTitles(): Readonly<Record<string, string>> {
  return useContext(CrumbTitleContext)?.titles ?? {};
}
