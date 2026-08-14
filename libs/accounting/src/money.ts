/**
 * Money as integer centavos.
 *
 * §11: money never goes through `float`. The allocator is the one place in
 * this package that does real arithmetic on amounts rather than just
 * copying them onto a journal line, so it is the one place that needs to
 * be exact.
 *
 * Why centavos rather than a Decimal library. `libs/accounting` is tagged
 * `type:domain, scope:shared` — it is allowed in a browser bundle, so it
 * must not reach for `@prisma/client` (which is where the workspace's only
 * `Decimal` implementation lives, bundled inside the Prisma runtime).
 * Pulling a second decimal library in for four arithmetic operations on
 * two-decimal values would be a dependency to carry forever. Integers are
 * exact, need nothing, and are what the domain actually is: the peso's
 * smallest unit is the centavo and no balance in this system is ever
 * denominated in anything finer.
 *
 * Range: `Decimal(14, 2)` tops out at 999,999,999,999.99 — 10^14 centavos.
 * `Number.MAX_SAFE_INTEGER` is ~9.007 × 10^15, so a single amount has ~90×
 * headroom and the running totals across one loan's schedule are nowhere
 * near it. `assertSafe` fails loudly rather than silently losing a centavo
 * if that ever stops being true.
 *
 * The conversion in is string-mediated on purpose. `Number(decimal)` is
 * precisely the step §11 objects to, and `Math.round(Number(d) * 100)`
 * launders it rather than removing it. Parsing the decimal *text* — which
 * is what `Prisma.Decimal.toString()` and Postgres `NUMERIC` both give
 * back — never constructs the float at all.
 */

/**
 * Anything that can state an exact decimal amount: a JS number, a decimal
 * string, or a `Prisma.Decimal` (structurally — accepted via `toString`,
 * so this package still has no Prisma dependency).
 */
export type MoneyInput = number | string | { toString(): string };

/** Largest centavo magnitude we will handle without complaint. */
const MAX_CENTAVOS = Number.MAX_SAFE_INTEGER;

function assertSafe(centavos: number, source: string): void {
  if (!Number.isFinite(centavos) || Math.abs(centavos) > MAX_CENTAVOS) {
    throw new RangeError(
      `Money value out of safe integer range: ${source} → ${centavos} centavos`,
    );
  }
}

/**
 * Exact decimal text → integer centavos.
 *
 * Handles the forms `Prisma.Decimal`, Postgres `NUMERIC` and JS numbers
 * actually produce: optional sign, digits, optional fraction, and — because
 * `String(1e-7)` and `String(1e21)` do it — exponent notation.
 *
 * More than two fraction digits are rounded half away from zero, matching
 * the `Math.round(n * 100) / 100` this replaces for the non-negative
 * amounts money allocation deals in. Inputs from `Decimal(14, 2)` columns
 * never have a third digit, so in practice nothing is rounded at all.
 */
export function toCentavos(value: MoneyInput): number {
  const text = typeof value === "string" ? value : String(value);
  const trimmed = text.trim();
  if (trimmed === "") throw new TypeError("Money value is empty");

  // Exponent form — rare, but `String()` produces it at the extremes, and
  // silently mis-parsing "1e-7" as 1 would be a real centavo lost.
  const exp = /^([+-]?)(\d*)(?:\.(\d*))?[eE]([+-]?\d+)$/.exec(trimmed);
  if (exp) {
    const [, sign, int = "", frac = "", power] = exp;
    return shiftToCentavos(sign === "-", int, frac, Number(power), trimmed);
  }

  const plain = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(trimmed);
  if (!plain || (plain[2] === "" && (plain[3] ?? "") === "")) {
    throw new TypeError(`Not a decimal money value: ${text}`);
  }
  const [, sign, int = "", frac = ""] = plain;
  return shiftToCentavos(sign === "-", int, frac, 0, trimmed);
}

/**
 * Assembles `±int.frac × 10^power` as centavos, i.e. shifted by
 * `power + 2` digits, rounding half away from zero at that position.
 */
function shiftToCentavos(
  negative: boolean,
  int: string,
  frac: string,
  power: number,
  source: string,
): number {
  const digits = `${int}${frac}`;
  // Position of the decimal point within `digits`, then shifted right by
  // the exponent and by two more to land on centavos.
  const point = int.length + power + 2;

  let whole: string;
  let remainder: string;
  if (point <= 0) {
    whole = "0";
    remainder = `${"0".repeat(-point)}${digits}`;
  } else if (point >= digits.length) {
    whole = `${digits}${"0".repeat(point - digits.length)}`;
    remainder = "";
  } else {
    whole = digits.slice(0, point);
    remainder = digits.slice(point);
  }

  let centavos = whole === "" ? 0 : Number(whole);
  assertSafe(centavos, source);
  // Half away from zero on the first discarded digit.
  if (remainder !== "" && remainder.charCodeAt(0) >= 53 /* "5" */) {
    centavos += 1;
  }
  assertSafe(centavos, source);
  return negative ? -centavos : centavos;
}

/**
 * Integer centavos → the 2-decimal JS number the journal builders and the
 * `PaymentAllocation` shape are written in.
 *
 * This is the same division `round2` ends with — `Math.round(n * 100) / 100`
 * — so a figure that came through the old float path and one that came
 * through centavos land on the identical double. That identity is what the
 * allocation golden tests assert.
 */
export function fromCentavos(centavos: number): number {
  assertSafe(centavos, String(centavos));
  return centavos / 100;
}

/**
 * Integer centavos → exact 2-decimal text, built from integer division and
 * string padding so the value never becomes a double on the way out.
 *
 * This is what to write to a `Decimal(14, 2)` column. Prisma accepts a
 * string for a Decimal field and parses it exactly; handing it a JS number
 * would put a float back on the one path §11 is about, right at the end.
 */
export function centavosToDecimalString(centavos: number): string {
  assertSafe(centavos, String(centavos));
  const negative = centavos < 0;
  const abs = Math.abs(centavos);
  const pesos = Math.floor(abs / 100);
  const rest = abs % 100;
  return `${negative ? "-" : ""}${pesos}.${String(rest).padStart(2, "0")}`;
}

/**
 * Sum money exactly, returning 2-decimal text ready for a Decimal column.
 * Accepts anything `toCentavos` does, so a `Prisma.Decimal` straight off a
 * row and a JS number from an allocation slice can be added without either
 * being converted to the other first.
 */
export function addMoney(...values: MoneyInput[]): string {
  let total = 0;
  for (const v of values) total += toCentavos(v);
  return centavosToDecimalString(total);
}

/**
 * `a >= b`, compared exactly in centavos.
 *
 * This is the settlement test: has enough been collected on this
 * installment to close it. It used to be written as `paid + 0.005 >= due`,
 * a half-centavo tolerance guarding against float error on both sides.
 * With the comparison in integers there is no error to guard against, and
 * the tolerance was in any case unreachable — both operands come from
 * `Decimal(14, 2)`, so nothing is representable between `due - 0.01`, which
 * must not settle, and `due`, which must.
 */
export function isAtLeast(a: MoneyInput, b: MoneyInput): boolean {
  return toCentavos(a) >= toCentavos(b);
}
