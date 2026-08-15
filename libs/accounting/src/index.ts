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
/*
 * Named exports rather than `export *`. `money.ts` and `profitability.ts`
 * both carry a `toCentavos` / `fromCentavos` pair, and they are genuinely
 * different functions: profitability's parses ledger-line text and REFUSES
 * anything that is not two decimals — a third digit there means the data is
 * wrong, and it says so — while money's accepts any decimal a caller can
 * hold. Re-exporting both wholesale is ambiguous, and collapsing them would
 * mean either weakening that refusal or narrowing the allocator's input.
 * So the report-local pair keeps the bare names and the general helpers are
 * reached through this list.
 */
export {
  type MoneyInput,
  addMoney,
  centavosToDecimalString,
  isAtLeast,
  openCentavos,
} from "./money";
export * from "./posting";
export * from "./reports";
export * from "./roll-rate";
export * from "./profitability";
export * from "./periods";
