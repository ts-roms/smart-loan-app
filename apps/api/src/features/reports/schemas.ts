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
  format: z.enum(["json", "csv"]).default("json"),
});
export type ReportQuery = z.infer<typeof querySchema>;

/**
 * Supported report types, mapped to FRD audit-clause sections in the
 * route file. Validating the type set here means a typo in the URL
 * produces a 400, not a 404, which is closer to the truth (we know
 * what's supported; the user asked for something that's *not* it).
 */
export const reportTypes = [
  "dorsi-utilization",
  "penalty-waivers",
  "demand-letters",
  "repossession-cases",
  "annual-docs",
  "ecl-movement",
] as const;
export type ReportType = (typeof reportTypes)[number];

export const reportTypeSchema = z.enum(reportTypes);
