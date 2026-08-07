// Public API of the audit feature.
//
// The log is a PAGE under Administration, not the navbar drawer it used
// to be: a drawer capped at the newest 100 with no way back could answer
// "what just happened" but not "what happened on the 14th", which is the
// question an audit log exists for.
export { AuditLogPage } from "./pages/AuditLog";
