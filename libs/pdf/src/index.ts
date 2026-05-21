/**
 * @loan/pdf — server-side PDF generation via pdfkit.
 *
 *   - renderLoanAgreement       — formal loan agreement + TIL disclosure
 *   - renderPaymentReceipt      — single-page OR for a posted payment
 *   - renderStatementOfAccount  — per-loan schedule + payments + balance
 *   - renderCustomerStatement   — per-customer unified ledger statement
 *
 * All renderers are pure: data in, Buffer out. The API route streams the
 * result with `Content-Type: application/pdf`; nothing is persisted to disk.
 */

export * from "./agreement.js";
export * from "./receipt.js";
export * from "./statement.js";
export * from "./customer-statement.js";
export { moneyPHP, pct, fmtDate, type PersonnelSignature } from "./chrome.js";
