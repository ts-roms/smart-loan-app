// reconciliation feature — exports the route plugin for the central
// registrar. Schemas extracted under ./schemas.ts; controller/service
// not split — the state machine lives inside
// BankReconciliationRepository, route handlers are thin adapters.
export { reconciliationRoutes } from "./reconciliation.routes.js";
