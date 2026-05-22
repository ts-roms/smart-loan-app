// collections feature — exports the route plugin for the central registrar.
// Layered: routes / controller / service / schemas. Wraps the
// CollectionsRepository for overdue queue + notes + PTPs + the late-fee
// accrual job (which surfaces closed-period errors as 409).
export { collectionsRoutes } from "./collections.routes";
