// Auth feature — mounted under /auth.
//
// Full layered split: routes + controller + service + schemas +
// helpers. Every endpoint here is security-critical and audit-coupled,
// so the orchestration contract (login, refresh-rotation, 2FA enable
// flow, recovery-code single-use) lives in auth.service.ts where it
// can be reviewed + tested independently of the HTTP shell.
export { authRoutes } from "./auth.routes.js";
export * from "./schemas.js";
