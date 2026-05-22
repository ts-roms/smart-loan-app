// lease feature — exports the route plugin for the central registrar.
// Layered: routes / controller / service / schemas. Four state
// transitions (buyout / pull-out / return / extend); buyout posts a
// settlement journal entry via LeaseRepository.
export { leaseRoutes } from "./lease.routes";
