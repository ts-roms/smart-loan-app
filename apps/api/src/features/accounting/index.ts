// Accounting feature — mounted under /accounting.
//
// Layering: journal-write paths (POST /journal, POST /journal/:id/reverse,
// POST /journal/reverse-bulk) go through JournalService + JournalController.
// The rest (COA, journal reads, ledger, reports, periods, accrual job)
// stay inline in accounting.routes.ts because they're thin repo
// passthroughs — see docs/architecture.md "earn its keep".
export { accountingRoutes } from "./accounting.routes";
export * from "./schemas";
