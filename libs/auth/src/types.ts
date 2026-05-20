export type UserRole = 'ADMIN' | 'LOAN_OFFICER' | 'ACCOUNTANT' | 'CUSTOMER';

export interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
}

// `@fastify/jwt` exposes its own extension point for the request.user
// type. Augmenting FastifyRequest directly would collide with the
// plugin's built-in `string | object | Buffer` typing — use the
// supported FastifyJWT interface instead.
declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload;
    user: JwtPayload;
  }
}
