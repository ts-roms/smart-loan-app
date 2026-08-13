import type { Config } from "tailwindcss";

/**
 * Marketing palette, as Tailwind tokens.
 *
 * The Vite marketing site had no Tailwind at all — the whole site was
 * inline `style={{}}` objects reading CSS custom properties declared in
 * a <style> block inside index.html. Those custom properties are kept
 * verbatim (see src/app/globals.css); this file only gives them names
 * Tailwind can emit utilities for, so the migration is a change of
 * *notation* and not of colour. Any pixel difference between the two
 * apps is a mistake, not a redesign.
 *
 * Deliberately NOT the `hsl(var(--x) / <alpha-value>)` form apps/web
 * uses. That form buys opacity modifiers (`bg-success/15`) but requires
 * every token to be stored as bare HSL channels. This palette already
 * ships hand-tuned `-soft` / `-ring` tints — the comment in the old
 * index.html explains they were re-tuned per theme because a mechanical
 * alpha turned muddy on white — so converting to channels would throw
 * away the tuning to buy a feature the tuning exists to replace.
 *
 * libs/ui is NOT in `content`, and that is a finding rather than an
 * omission. apps/web scans it because it renders its components; this
 * app does not render any — see docs/modernization/nextjs-migration.md
 * for what happened when the pilot tried. Scanning it anyway would emit
 * nothing useful: every `@loan/ui` class names a token this palette
 * does not define (`bg-primary`, `ring-ring`, `ring-offset-surface-2`),
 * so Tailwind would skip them all. That mismatch — not the RSC boundary
 * — is the reason a `@loan/ui` button cannot simply be dropped onto
 * this site, and it was measured: the probe's server-rendered
 * `<button class="… bg-primary …">` compiled clean and came out
 * completely unstyled.
 */
export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: "var(--bg)",
          elev: "var(--bg-elev)",
        },
        border: "var(--border)",
        fg: {
          DEFAULT: "var(--text)",
          dim: "var(--text-dim)",
          muted: "var(--text-muted)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          strong: "var(--accent-strong)",
          soft: "var(--accent-soft)",
          ring: "var(--accent-ring)",
        },
        success: {
          DEFAULT: "var(--success)",
          soft: "var(--success-soft)",
          ring: "var(--success-ring)",
        },
        warning: {
          DEFAULT: "var(--warning)",
          soft: "var(--warning-soft)",
          ring: "var(--warning-ring)",
        },
        danger: {
          DEFAULT: "var(--danger)",
          soft: "var(--danger-soft)",
          ring: "var(--danger-ring)",
        },
      },
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif",
        ],
        mono: ["ui-monospace", "Menlo", "Consolas", "monospace"],
      },
      maxWidth: {
        // The site's one layout constant: every container in the Vite
        // app was `maxWidth: 1100`.
        shell: "1100px",
      },
    },
  },
  plugins: [],
} satisfies Config;
