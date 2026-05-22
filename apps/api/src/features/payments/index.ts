// Payments feature — mounted under /payments. Covers the payment-
// gateway integration (PaymentIntent + provider webhook). The
// "record a payment against a loan" endpoint lives under /loans
// (see features/loans/loans.routes.ts) — different concern, different
// folder.
export { paymentsRoutes } from "./payments.routes.js";
export * from "./schemas.js";
