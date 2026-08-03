/**
 * Single source of truth for theme hex values that live OUTSIDE the
 * runtime CSS (manifest, meta tags, offline page, app icons). The
 * runtime UI itself reads HSL from CSS variables in
 * `libs/ui/src/globals.css` — those are the authority for anything
 * Tailwind/CSS touches.
 *
 * Why hex AND HSL: the build-time consumers (PWA manifest, OS status
 * bar meta tag, raw SVG `fill=` attributes, the static offline.html
 * page) can't reference CSS custom properties — they're resolved
 * before any stylesheet attaches. So we mirror the values here as
 * plain hex strings.
 *
 * To change the theme:
 *
 *   1. Edit the constants below.
 *   2. Edit the matching HSL in `libs/ui/src/globals.css` — that's
 *      what the running app actually paints with. Keep both in sync.
 *   3. Hand-sync the static assets that this module can't reach:
 *        - `apps/web/public/offline.html` (inline-styled fallback)
 *        - `apps/web/public/favicon.svg`
 *        - `apps/web/public/icons/icon.svg`
 *        - `apps/web/public/icons/icon-maskable.svg`
 *      A grep for the old hex covers it.
 *
 * Consumers (auto-synced via vite.config.ts):
 *
 *   • PWA manifest `theme_color` + `background_color`
 *   • `index.html` `<meta name="theme-color">` (Android status bar,
 *     iOS Safari chrome)
 */

/*
 * These track the LIGHT palette, which is what the product ships and
 * therefore what an install banner, a cold PWA launch, or the offline
 * page should look like. Someone running the dark theme sees a
 * one-frame light status bar on launch; the alternative — a dark
 * status bar above a light app — is worse and affects everyone.
 */
export const themeColors = {
  /** Page / app background. HSL: 220 20% 97%. */
  background: "#f6f7f9",
  /** Body / primary text. HSL: 222 24% 12%. */
  foreground: "#171c26",
  /** Brand accent — links, focus rings, primary buttons. HSL: 199 89% 42%. */
  primary: "#0b93cb",
} as const;

export type ThemeColorName = keyof typeof themeColors;
