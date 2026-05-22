// audit feature — exports the route plugin for the central registrar.
// Layered: routes / controller / service / schemas. Read-only API; the
// write path (`AuditLogRepository.record`) is invoked inline from every
// feature service that performs a privileged action.
export { auditRoutes } from "./audit.routes";
