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

export const themeColors = {
  /** Page / app background. HSL: 220 13% 9%. */
  background: "#14171c",
  /** Body / primary text. HSL: 213 18% 88%. */
  foreground: "#dbe1e8",
  /** Brand accent — links, focus rings, primary buttons. HSL: 199 70% 62%. */
  primary: "#54b6e8",
} as const;

export type ThemeColorName = keyof typeof themeColors;
