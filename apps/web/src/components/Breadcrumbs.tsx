import { cn } from "@loan/ui";
import { ChevronRight } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { useCrumbTitles } from "../providers/breadcrumb-titles";

/**
 * Label for a route pattern. `:segment` matches any single segment.
 *
 * A route with no entry here contributes NO crumb — the walk simply
 * skips it. That's the mechanism behind two deliberate omissions:
 *
 *   /loans/new/:draftId  resuming a draft is still "New loan", so the
 *                        draft id is dropped and /loans/new supplies
 *                        the crumb.
 *   /compliance          not a real page; /compliance/dorsi hangs off
 *                        nothing. Rather than invent a dead crumb, the
 *                        trail goes Dashboard › DORSI compliance.
 *                        (/payments used to sit here too, until the
 *                        payments console made it a real page.)
 *
 * Labels match the sidebar wording wherever a route has a nav entry, so
 * the crumb and the highlighted rail agree. Where they differ it's
 * because the sidebar has room for a qualifier the trail doesn't need.
 */
type CrumbRoute = readonly [pattern: string, label: string];

const STAFF_ROUTES: readonly CrumbRoute[] = [
  ["/", "Dashboard"],

  ["/customers", "Customers"],
  ["/customers/bulk", "Bulk import"],
  ["/customers/:id", ""], // resolved from the published title
  ["/customers/:id/survey", "Credit survey"],
  ["/kyc", "KYC review"],

  ["/pre-assessments", "Pre-assessment"],
  ["/loans", "Loans"],
  ["/loans/drafts", "Drafts"],
  ["/loans/new", "New loan"],
  ["/loans/:id", ""],
  ["/loan-products", "Loan products"],

  ["/collections", "Collections"],
  ["/collections/my-accounts", "My accounts"],
  ["/collections/demand-letters", "Demand letters"],
  ["/repossession", "Repossession"],
  ["/lease", "Lease-to-Own"],
  ["/payments", "Payments"],
  ["/payments/bulk", "Bulk payments"],

  ["/accounting", "Accounting"],
  ["/accounting/accounts", "Chart of accounts"],
  ["/accounting/journal", "Journal entries"],
  ["/accounting/trial-balance", "Trial balance"],
  ["/accounting/income-statement", "Income statement"],
  ["/accounting/balance-sheet", "Balance sheet"],
  ["/accounting/portfolio", "Loan portfolio"],
  ["/accounting/periods", "Periods"],
  ["/accounting/ecl", "ECL provisioning"],
  ["/accounting/analytics", "Analytics"],
  ["/reconciliation", "Bank reconciliation"],
  ["/reconciliation/:id", ""],

  ["/cooperative", "Contributions & funds"],

  ["/questionnaires", "Questionnaires"],
  ["/decision-rules", "Decision rules"],
  ["/screening", "AML watchlist"],
  ["/compliance/annual-docs", "Renewable docs"],
  ["/compliance/dorsi", "DORSI compliance"],
  ["/reports", "Reports"],
  ["/notifications", "Notifications"],

  ["/users", "Users"],
  ["/users/bulk", "Bulk users"],
  ["/roles", "Roles"],
  ["/delegations", "Delegations"],
  ["/jobs", "Jobs"],

  ["/profile", "My profile"],
  ["/settings", "Settings"],
  ["/help", "Help"],
];

const PORTAL_ROUTES: readonly CrumbRoute[] = [
  ["/portal", "Dashboard"],
  ["/portal/pre-assess", "Check eligibility"],
  ["/portal/apply", "New loan"],
  ["/portal/loans", "My loans"],
  ["/portal/loans/:id", ""],
  ["/portal/savings", "My savings"],
  ["/portal/contributions", "Contributions"],
  ["/portal/ledger", "My ledger"],
  ["/portal/kyc", "Documents"],
  ["/portal/profile", "My profile"],
];

function segments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

/** Does a `:`-pattern describe this concrete path? */
function matches(pattern: string, path: string): boolean {
  const p = segments(pattern);
  const s = segments(path);
  if (p.length !== s.length) return false;
  return p.every((seg, i) => seg.startsWith(":") || seg === s[i]);
}

/**
 * An empty label means "ask the page what this is called" — see
 * useCrumbTitle. Note this is a property of the LABEL, not of the
 * pattern: /customers/:id/survey has a param but is always "Credit
 * survey", and keying off the param instead rendered it as "survey".
 */
function needsTitle(label: string): boolean {
  return label === "";
}

export interface Crumb {
  path: string;
  label: string;
  /** True when the label is a raw URL segment we couldn't resolve. */
  unresolved: boolean;
}

/**
 * Build the trail for `path` by walking its prefixes outward-in.
 *
 * Prefix walking rather than a parent pointer per route: the URL
 * hierarchy already encodes the nesting, and a table of parents would
 * be a second place to keep in sync with App.tsx.
 *
 * Exported for direct testing — the DOM is a poor place to assert 40
 * routes' worth of trails.
 */
export function buildTrail(
  path: string,
  routes: readonly CrumbRoute[],
  titles: Readonly<Record<string, string>> = {},
): Crumb[] {
  const root = routes[0]![0];
  const parts = segments(path);
  const crumbs: Crumb[] = [];

  // Every prefix, shortest first: "/a/b/c" -> "/", "/a", "/a/b", "/a/b/c".
  // The portal's root is "/portal", so its walk starts one level in and
  // never emits a crumb for the staff dashboard.
  const prefixes = [
    root,
    ...parts.map((_, i) => "/" + parts.slice(0, i + 1).join("/")),
  ];

  for (const prefix of prefixes) {
    if (!prefix.startsWith(root)) continue;
    if (crumbs.some((c) => c.path === prefix)) continue;
    const hit = routes.find(([pattern]) => matches(pattern, prefix));
    if (!hit) continue; // unmapped level — contributes nothing, see CrumbRoute

    const [, label] = hit;
    if (needsTitle(label)) {
      const published = titles[prefix];
      crumbs.push({
        path: prefix,
        label: published ?? segments(prefix).at(-1) ?? prefix,
        unresolved: !published,
      });
    } else {
      crumbs.push({ path: prefix, label, unresolved: false });
    }
  }

  return crumbs;
}

/**
 * Styling for a crumb still showing a raw URL segment.
 *
 * Applies to link crumbs as well as the current one: deep-linking to
 * /customers/:id/survey renders the middle crumb as a bare uuid,
 * because only the customer page it skipped would have published the
 * name. Mono marks it as an id rather than prose, and the width cap
 * keeps a 36-character uuid from stretching the whole trail — the full
 * value stays available via the title attribute.
 */
function unresolvedStyle(crumb: Crumb): string | false {
  return crumb.unresolved && "font-mono max-w-[14ch]";
}

/**
 * Location trail above the page content.
 *
 * Sits in the content area rather than the top bar because PortalShell
 * has no desktop header to put it in, and because the staff header
 * already carries five controls that would be squeezed at 375px.
 *
 * Renders nothing on a root page, where the only crumb would be the
 * page you're already on.
 */
export function Breadcrumbs({ variant }: { variant: "staff" | "portal" }) {
  const { pathname } = useLocation();
  const titles = useCrumbTitles();
  const routes = variant === "portal" ? PORTAL_ROUTES : STAFF_ROUTES;
  const trail = buildTrail(pathname, routes, titles);

  if (trail.length < 2) return null;

  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex items-center gap-1 text-xs text-fg-muted">
        {trail.map((crumb, i) => {
          const isLast = i === trail.length - 1;
          // Keep the first and last two rungs on a phone; drop the
          // middle. A four-deep trail can't fit at 375px, and the ends
          // are the useful parts — where you are, and one level up.
          const collapsible = i > 0 && i < trail.length - 2;
          return (
            <li
              key={crumb.path}
              className={cn(
                "flex items-center gap-1 min-w-0",
                collapsible && "hidden md:flex",
              )}
            >
              {i > 0 && (
                <ChevronRight
                  aria-hidden="true"
                  className="h-3 w-3 shrink-0 text-fg-subtle"
                />
              )}
              {isLast ? (
                <span
                  aria-current="page"
                  title={crumb.unresolved ? crumb.label : undefined}
                  className={cn("truncate text-fg", unresolvedStyle(crumb))}
                >
                  {crumb.label}
                </span>
              ) : (
                <Link
                  to={crumb.path}
                  title={crumb.unresolved ? crumb.label : undefined}
                  className={cn(
                    "truncate rounded-sm hover:text-fg hover:underline underline-offset-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    unresolvedStyle(crumb),
                  )}
                >
                  {crumb.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
