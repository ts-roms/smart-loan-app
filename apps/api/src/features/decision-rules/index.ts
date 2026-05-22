// decision-rules feature — exports the route plugin for the central
// registrar. Layered: routes / controller / service / schemas. Owns the
// rule catalog feeding /loans/:id/decide; create surfaces unique-name
// conflicts as 409.
export { decisionRuleRoutes } from "./decision-rules.routes";
