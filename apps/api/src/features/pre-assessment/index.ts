// pre-assessment feature — exports the route plugin for the central
// registrar, plus the service the borrower portal reuses for its own
// customer-scoped endpoint. Layered: routes / controller / service /
// schemas. The evaluation itself lives in lib/pre-decision.ts, shared
// with POST /loans/dry-run.
export { preAssessmentRoutes } from "./pre-assessment.routes";
export { PreAssessmentService, type RunResult } from "./pre-assessment.service";
export {
  portalPreAssessmentSchema,
  type PortalPreAssessmentInput,
} from "./schemas";
