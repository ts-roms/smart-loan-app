import {
  ROLL_RATE_DESTINATIONS,
  ROLL_RATE_ORIGINS,
  type RollRateDestination,
  type RollRateOrigin,
} from "@loan/accounting";
import { z } from "zod";

/**
 * Compliance-report query shape. The single endpoint takes a `:type`
 * path param + a date range + an output format. `from` defaults to
 * one month ago, `to` defaults to now — handled in the service so the
 * defaulting rules are testable without HTTP.
 */
export const querySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  /**
   * Area narrowing for the collections-aging report — matched
   * case-insensitively against the borrower's recorded city/province,
   * since the values arrive typed rather than picked from a list.
   * Ignored by the report types that have no geographic dimension.
   */
  province: z.string().max(80).optional(),
  city: z.string().max(80).optional(),
  format: z.enum(["json", "csv"]).default("json"),
});
export type ReportQuery = z.infer<typeof querySchema>;

/**
 * Supported report types, mapped to audit-clause sections in the
 * route file. Validating the type set here means a typo in the URL
 * produces a 400, not a 404, which is closer to the truth (we know
 * what's supported; the user asked for something that's *not* it).
 */
export const reportTypes = [
  "collections-aging",
  "dorsi-utilization",
  "penalty-waivers",
  "demand-letters",
  "repossession-cases",
  "annual-docs",
  "ecl-movement",
] as const;
export type ReportType = (typeof reportTypes)[number];

export const reportTypeSchema = z.enum(reportTypes);

// ─── Roll-rate (§30) ─────────────────────────────────────────────────
//
// A dedicated route rather than an eighth `:type`, because its payload is
// a matrix, not the flat rows the CSV dispatcher expects — and because a
// matrix flattened to CSV rows would misrepresent what it is.

/**
 * `from`/`to` accept the same date-only shape as the accounting reports
 * ("2026-07-01" or a full ISO timestamp) — validated in the handler, not
 * here, for the reason documented on `parseAsOf` in accounting.routes.ts:
 * a `format: date-time` would reject exactly the date-only form these
 * parameters exist for.
 */
export const rollRateQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

// Enum values derived from @loan/accounting's exported orders — the
// bands are stated once, there.
const rollRateOriginSchema = z.enum(
  ROLL_RATE_ORIGINS as [RollRateOrigin, ...RollRateOrigin[]],
);
const rollRateDestinationSchema = z.enum(
  ROLL_RATE_DESTINATIONS as [RollRateDestination, ...RollRateDestination[]],
);

const rollRateCellSchema = z.object({
  destination: rollRateDestinationSchema,
  count: z.number().int(),
  amount: z.number(),
  countFraction: z.number(),
  amountFraction: z.number(),
});

const rollRateRowSchema = z.object({
  origin: rollRateOriginSchema,
  loanCount: z.number().int(),
  amount: z.number(),
  cells: z.array(rollRateCellSchema),
});

export const rollRateResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  totalLoans: z.number().int(),
  origins: z.array(rollRateOriginSchema),
  destinations: z.array(rollRateDestinationSchema),
  overall: z.array(rollRateRowSchema),
  byProduct: z.array(
    z.object({
      productCode: z.string(),
      rows: z.array(rollRateRowSchema),
    }),
  ),
});
