// rbac feature — exports the route plugin for the central registrar.
// Layered: routes / controller / service / schemas. Permission catalog
// + role CRUD + user CRUD + role assignments; the ADMIN self-lockout
// guard + customer-link rule live in the service.
export { rbacRoutes } from "./rbac.routes";
