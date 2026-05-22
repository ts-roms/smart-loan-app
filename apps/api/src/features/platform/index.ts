/**
 * Platform-console feature — the vendor's control plane.
 *
 * Distinct from every other feature: lives in the same Fastify
 * instance as the tenant API but operates on `public`-schema tables
 * (Tenant, PlatformUser, PlatformAuditLog) and never reads or writes
 * per-tenant domain data.
 *
 * The route plugin handles its own JWT verification + role checks;
 * tenant-side `requirePermission` doesn't apply to /platform/* routes.
 */
export { platformRoutes } from "./platform.routes";
export type { PlatformJwtPayload, PlatformService } from "./platform.service";
