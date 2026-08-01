// uploads feature — exports the route plugin for the central registrar.
// Single endpoint, no controller/service split: the handler is a thin
// adapter over the filesystem with no orchestration to extract (see
// docs/architecture.md — "earn its keep").
export { uploadRoutes } from "./uploads.routes";
