// repossession feature — exports the route plugin for the central
// registrar. Layered: routes / controller / service / schemas.
// state machine with eight audit-coupled transitions; auction posts the
// settlement journal entry.
export { repossessionRoutes } from "./repossession.routes";
