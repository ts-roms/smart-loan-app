/**
 * Compliance feature — GDPR / PH Data Privacy Act §16(c) (right to
 * access) + §16(e) (right to erasure / blocking) workflows.
 *
 * Layered: routes → controller → service. The service handles the
 * actual data assembly + redaction; the controller is a thin HTTP
 * adapter; the routes file wires per-request services.
 *
 * @see docs/runbooks.md (future R7: DSAR response procedure)
 */

export { complianceRoutes } from "./compliance.routes";
export {
  ComplianceService,
  type ExportArgs,
  type ExportResult,
  type EraseArgs,
  type EraseResult,
} from "./compliance.service";
