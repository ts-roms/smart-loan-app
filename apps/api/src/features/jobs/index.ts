// jobs feature — factory plugin exposing jobs introspection routes.
// Not a layered feature router: the actual job scheduler decorates
// `app.jobs` via @loan/jobs; this only surfaces the run history + a
// trigger endpoint (see features/README.md).
export { jobRoutes } from "./jobs.routes";
