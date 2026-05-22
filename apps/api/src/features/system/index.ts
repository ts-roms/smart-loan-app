// system feature — exports the route plugin for the central registrar.
// Schemas extracted under ./schemas.ts (idle-policy + branding upsert
// shapes); controller/service not split — handlers are upserts against
// the singleton SystemConfig row.
export { systemRoutes } from "./system.routes";
