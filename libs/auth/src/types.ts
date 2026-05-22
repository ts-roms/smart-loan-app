export type UserRole = "ADMIN" | "LOAN_OFFICER" | "ACCOUNTANT" | "CUSTOMER";

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
