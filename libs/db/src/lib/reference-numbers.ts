import type { PrismaClient } from "@prisma/client";

/**
 * Reference-number helpers.
 *
 * The app uses human-readable numbers ("CUST-2026-000123", "LN-2026-000045",
 * "KYC-2026-000007", …) in URLs and operator UI instead of UUIDs. Each
 * model with a numbered identifier follows the same shape:
 *
 *   {PREFIX}-{YEAR}-{6-digit zero-padded sequence}
 *
 * The sequence resets per calendar year so the number tells you when the
 * row was created at a glance. A few entities (Vehicle, Property) use a
 * flat counter instead because their creation year isn't a meaningful
 * grouping for collateral.
 *
 * Why not a SQL sequence?  Postgres sequences don't reset per-year and
 * fighting them is uglier than a tiny "find the last and bump" query —
 * see the inline notes in each helper below. The lookup is indexed on
 * `number` so it's a B-tree scan, not a table sweep.
 */

const YEAR = () => new Date().getFullYear();
const pad6 = (n: number): string => String(n).padStart(6, "0");

/**
 * Pulls the latest `PREFIX-YYYY-...` number for the current year, parses
 * the sequence segment, and returns it + 1. Returns 1 when there are no
 * rows yet for this year.
 */
async function nextSeq(
  prisma: PrismaClient,
  table:
    | "customer"
    | "kycSubmission"
    | "paymentIntent"
    | "loanApplication"
    | "journalEntry",
  prefix: string,
  year: number,
): Promise<number> {
  // Each Prisma model exposes the same `findFirst` shape — TS just can't
  // see that through the union type, so we widen here. The shape is
  // verified by callers passing a literal table name.
  const model = (
    prisma as unknown as Record<
      string,
      { findFirst: (args: unknown) => Promise<{ number: string } | null> }
    >
  )[table]!;
  const last = await model.findFirst({
    where: { number: { startsWith: `${prefix}-${year}-` } },
    orderBy: { number: "desc" },
    select: { number: true },
  });
  if (!last) return 1;
  const m = new RegExp(`${prefix}-\\d{4}-(\\d+)`).exec(last.number);
  return m ? parseInt(m[1]!, 10) + 1 : 1;
}

/** "CUST-2026-000123" — per-year reset. */
export async function nextCustomerNumber(
  prisma: PrismaClient,
): Promise<string> {
  const y = YEAR();
  const seq = await nextSeq(prisma, "customer", "CUST", y);
  return `CUST-${y}-${pad6(seq)}`;
}

/** "KYC-2026-000123" — per-year reset. */
export async function nextKycNumber(prisma: PrismaClient): Promise<string> {
  const y = YEAR();
  const seq = await nextSeq(prisma, "kycSubmission", "KYC", y);
  return `KYC-${y}-${pad6(seq)}`;
}

/** "PI-2026-000123" — per-year reset. */
export async function nextPaymentIntentNumber(
  prisma: PrismaClient,
): Promise<string> {
  const y = YEAR();
  const seq = await nextSeq(prisma, "paymentIntent", "PI", y);
  return `PI-${y}-${pad6(seq)}`;
}

/** "VEH-000123" — flat counter; year is meaningless for collateral. */
export async function nextVehicleNumber(prisma: PrismaClient): Promise<string> {
  const last = await prisma.vehicle.findFirst({
    where: { number: { startsWith: "VEH-" } },
    orderBy: { number: "desc" },
    select: { number: true },
  });
  const lastSeq = last
    ? parseInt(/VEH-(\d+)/.exec(last.number)?.[1] ?? "0", 10)
    : 0;
  return `VEH-${pad6(lastSeq + 1)}`;
}

/** "PROP-000123" — flat counter; year is meaningless for collateral. */
export async function nextPropertyNumber(
  prisma: PrismaClient,
): Promise<string> {
  const last = await prisma.property.findFirst({
    where: { number: { startsWith: "PROP-" } },
    orderBy: { number: "desc" },
    select: { number: true },
  });
  const lastSeq = last
    ? parseInt(/PROP-(\d+)/.exec(last.number)?.[1] ?? "0", 10)
    : 0;
  return `PROP-${pad6(lastSeq + 1)}`;
}

// ─── id-or-number resolvers ───────────────────────────────────────────
//
// API routes accept either a UUID or a human number on the path:
//
//   /api/v1/customers/CUST-2026-000123          → preferred
//   /api/v1/customers/aa64b8d8-cf16-4b4a-...    → still works
//
// The resolvers below sniff the shape (uuid vs. prefixed string) and
// dispatch the right Prisma lookup. A bad input (random gibberish) just
// misses both branches and yields null — same as a 404.

/**
 * Loose UUID detector. Catches v1-v5 and the leading-prefix variants we
 * use (the schema's `@default(uuid())` emits v4). We don't validate the
 * version byte because Prisma will simply not find a non-existent UUID
 * anyway — the goal here is just to route the right Prisma query.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Build a Prisma `where` clause that matches either {id} (when the input
 * looks like a UUID) or {number}. Centralizing this so every repo's
 * `findByIdOrNumber` stays trivial — and so a future move to a different
 * id shape only touches one place.
 */
export function idOrNumberWhere(
  value: string,
): { id: string } | { number: string } {
  return isUuid(value) ? { id: value } : { number: value };
}
