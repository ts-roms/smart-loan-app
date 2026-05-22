// jobs feature — re-exports the route plugin for the central registrar.
// The handlers remain a single jobs.routes.ts for now; controller/service
// split deferred until the file is actively edited (see customers/ canary
// for the layered pattern when that happens).
export { jobRoutes } from "./jobs.routes.js";
