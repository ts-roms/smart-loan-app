/**
 * @loan/collections — pure decision logic for working delinquent accounts.
 *
 * - `weights.ts`  The priority weights, in one place, with their intent.
 * - `priority.ts` The §29 score, its per-factor breakdown, and the
 *                 recommended action / channel / follow-up date.
 *
 * No DB access here — persistence and the queue query live in @loan/db.
 * Aging bands come from @loan/accounting and balances from @loan/loans;
 * neither is re-derived in this package.
 */

export * from "./weights";
export * from "./priority";
