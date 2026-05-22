// delegations feature — re-exports the route plugin for the central registrar.
// The handlers remain a single delegations.routes.ts for now; controller/service
// split deferred until the file is actively edited (see customers/ canary
// for the layered pattern when that happens).
export { delegationRoutes } from "./delegations.routes.js";
