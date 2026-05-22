/**
 * Portal helpers — small pure utilities used by both controller and
 * service. Kept here so the CSV escaper isn't duplicated between the
 * customer-ledger CSV and the contributions/savings CSV paths.
 */

/**
 * Minimal RFC-4180 CSV encoder. Quotes any cell that contains a comma,
 * quote, or newline; doubles-up embedded quotes. Sufficient for
 * Excel / Google Sheets imports. We don't depend on a CSV lib here
 * because the payload is small and the format is fully under our
 * control — adding a dep for this would be silly.
 */
export function toCsv(header: string[], rows: string[][]): string {
  const escape = (cell: string): string => {
    if (/[",\n\r]/.test(cell)) {
      return `"${cell.replace(/"/g, '""')}"`;
    }
    return cell;
  };
  const lines = [header.map(escape).join(",")];
  for (const row of rows) lines.push(row.map(escape).join(","));
  return lines.join("\r\n") + "\r\n";
}

export type LedgerScope = "ALL" | "LOANS" | "COOP";

/**
 * Coerce a raw query-string scope to the typed enum the ledger repo
 * expects. Anything not in the set falls back to "ALL" so a typo in
 * the URL doesn't 400 the user out of their own statement.
 */
export function parseScope(raw: string | undefined): LedgerScope {
  const up = (raw ?? "ALL").toUpperCase();
  return up === "LOANS" || up === "COOP" || up === "ALL"
    ? (up as LedgerScope)
    : "ALL";
}

/**
 * Extract the client IP for audit purposes. Honors the first hop in
 * `X-Forwarded-For` when present (we run behind a load balancer in
 * staging+prod), falls back to the immediate-peer IP otherwise.
 */
export function clientIp(
  headers: Record<string, unknown>,
  fallback: string,
): string {
  const xff = headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return fallback;
}
