// health feature — liveness + readiness probes. No auth, no body, no
// orchestration; stays as a single routes file by design (see
// features/README.md).
export { healthRoutes } from "./health.routes";
