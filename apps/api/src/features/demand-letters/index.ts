// demand-letters feature — exports the route plugin for the central
// registrar. Layered: routes / controller / service / schemas.
// stage-gated approval + segregation-of-duties + best-effort dispatch
// notifications live in the service.
export { demandLetterRoutes } from "./demand-letters.routes";
