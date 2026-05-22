// scoring feature — exports the route plugin for the central registrar.
// Layered: routes / controller / service / schemas. Survey submission
// orchestrates `computeCreditScore` + survey save + latest-score upsert
// in one call so the customer sees their tier immediately.
export { scoringRoutes } from "./scoring.routes";
