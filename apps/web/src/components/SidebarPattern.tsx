/**
 * Cover pattern for the nav rail.
 *
 * Same asset as the auth page, INVERTED, and the inversion is a
 * measurement rather than a preference.
 *
 * The rail is navy and the asset's dots are light grey (188,188,188 at
 * its densest). Laid on as supplied they lighten the rail toward the
 * light text sitting on it — and there is almost nothing to spend:
 * `--sidebar-fg-subtle` measures 4.564:1 against the rail, 0.064 above
 * the AA floor, and it carries the 11px uppercase section labels.
 * Measured against that text:
 *
 *   layer opacity   as supplied   inverted
 *   0.15            4.42  fails   4.59
 *   0.50            4.11  fails   4.65
 *   1.00            3.70  fails   4.74
 *
 * There is no opacity at which the light version is safe. Inverted, the
 * dots are dark, they DARKEN the rail, and contrast goes up rather than
 * down — the pattern pays for itself instead of costing something. Same
 * conclusion the card watermark reached on dark surfaces.
 *
 * `filter: invert(1)` only touches the RGB the element paints; alpha is
 * untouched, so the 88%-transparent asset stays 88% transparent.
 *
 * `-z-10` against `isolate` on the rail: the pattern has to paint
 * above the rail's own background but under the nav. Without the
 * isolate the negative index would drop it behind the rail entirely
 * and it would never be seen at all.
 *
 * Purely decorative: aria-hidden, no pointer events, and positioned
 * against the rail (hence `md:relative` on the aside) so it stays put
 * while the nav scrolls underneath it.
 */
export function SidebarPattern() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10 bg-cover bg-left-top bg-no-repeat opacity-80 [filter:invert(1)]"
      style={{
        backgroundImage: `url("${import.meta.env.BASE_URL}assets/background/cover-pattern.png")`,
      }}
    />
  );
}
