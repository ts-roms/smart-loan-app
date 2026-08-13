/**
 * Where the other two deployments live.
 *
 * Ported from apps/marketing/src/App.tsx, and the one substantive
 * change in the whole migration: the variables are renamed.
 *
 *   VITE_APP_URL       →  NEXT_PUBLIC_APP_URL
 *   VITE_PLATFORM_URL  →  NEXT_PUBLIC_PLATFORM_URL
 *
 * Not cosmetic. Vite inlines anything prefixed `VITE_`; Next inlines
 * anything prefixed `NEXT_PUBLIC_` and REFUSES to inline anything else
 * into client code. Both are build-time substitutions, so both have to
 * be passed as Docker build args — deploy/railway/Dockerfile.marketing
 * already does that for the VITE_ pair and would need the new names.
 * This rename is unavoidable and is the one migration cost that
 * reaches outside the app directory.
 *
 * The original reasoning is unchanged and worth keeping:
 *
 *   "/app"                    one public origin — marketing serves the
 *                             root and forwards /app/ to the web
 *                             service. This is the Railway setup; see
 *                             deploy/railway/proxy-app.inc.template.
 *   "https://app.example.com" the two sites on separate hostnames.
 *
 * `process.env.X` must be written out in full rather than read from a
 * destructured object or an index expression — Next's inliner is a
 * literal textual substitution over `process.env.NEXT_PUBLIC_*`, and
 * `env[key]` compiles to `undefined` in the browser bundle.
 */
export const appUrl: string =
  process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:5173";

/**
 * The vendor's platform console. Same reasoning as `appUrl`.
 *
 * This was once hardcoded to the dev port, which meant the PUBLIC
 * marketing site shipped a "Platform console" link pointing at
 * http://localhost:5174 — dead for every visitor, and it silently
 * advertises an internal surface.
 */
export const platformUrl: string =
  process.env.NEXT_PUBLIC_PLATFORM_URL ?? "http://localhost:5174";

/** Derive a URL-safe workspace name from what someone typed. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
