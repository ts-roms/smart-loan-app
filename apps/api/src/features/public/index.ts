/**
 * Public feature entry point. Registered directly in app.ts under
 * the `/public` prefix — outside `/api/v1` because anonymous
 * endpoints aren't part of the tenant-versioned API contract.
 */
export { publicRoutes } from "./public.routes";
