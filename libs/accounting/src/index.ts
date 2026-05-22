/**
 * @loan/accounting — pure functions for the general ledger.
 *
 * - `chart.ts`     Default chart of accounts + the codes auto-posting relies on.
 * - `posting.ts`   Builders for the journal entries each business event produces.
 * - `reports.ts`   Aggregators that turn raw ledger lines into reports.
 *
 * No DB access in this package — persistence lives in @loan/db.
 */

export * from "./chart";
export * from "./posting";
export * from "./reports";
export * from "./periods";
