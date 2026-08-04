/**
 * Mirrors the Prisma UserRole enum and USER_ROLES in @loan/shared-types.
 * Duplicated rather than imported: @loan/auth is the lowest layer and
 * takes no workspace dependencies, so a new role has to be added here
 * too. Three places, and the typechecker catches two of them.
 */
export type UserRole =
  "ADMIN" | "LOAN_OFFICER" | "ACCOUNTANT" | "COLLECTOR" | "CUSTOMER";

export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  /**
   * Tenant slug the user belongs to. Required for multi-tenant
   * deployments (Phase 2); the resolveTenant preHandler reads this
   * to bind the per-request Prisma client to the right schema.
   *
   * In single-tenant deployments this is always the value of
   * DEFAULT_TENANT_SLUG ("default"), and the fallback in
   * fastifyTenantPrisma points to app.prisma → public schema. Old
   * tokens minted before this field was added are rejected on the
   * next refresh; that's the cutover boundary.
   *
   * Optional in the type so platform-side tokens (which use a
   * separate `platform: true` discriminator) don't have to carry
   * it. Tenant routes that need it assert presence at the use site.
   */
  tenant?: string;
  /**
   * Set when the token was minted by a vendor's
   * `/platform/tenants/:slug/impersonate` call. Carries the
   * PlatformUser id + email + the purpose string the operator
   * supplied, so audit downstream of an impersonated session can
   * attribute actions to BOTH the tenant user (who appears as the
   * `sub` of the token) and the vendor support staff who was
   * acting on their behalf.
   *
   * Normal tenant logins never set this. Routes that record
   * sensitive actions should include `impersonatedBy` in their
   * audit payload so the trail makes sense in retrospect.
   */
  impersonatedBy?: {
    platformUserId: string;
    platformUserEmail: string;
    purpose: string;
  };
}

// `@fastify/jwt` exposes its own extension point for the request.user
// type. Augmenting FastifyRequest directly would collide with the
// plugin's built-in `string | object | Buffer` typing — use the
// supported FastifyJWT interface instead.
declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: JwtPayload;
    user: JwtPayload;
  }
}
