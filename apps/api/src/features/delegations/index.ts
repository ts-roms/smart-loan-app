// delegations feature — exports the route plugin for the central
// registrar. Layered: routes / controller / service / schemas. Permission
// gate on contents + delegator-vs-caller authority + extend-after-revoke
// rules live in the service.
export { delegationRoutes } from "./delegations.routes";
