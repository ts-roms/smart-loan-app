/**
 * Health endpoints — split into liveness vs readiness so container
 * orchestrators (k8s, ECS, Fly machines) can probe each independently.
 *
 *   GET /health         legacy alias for /health/live
 *   GET /health/live    process is up. Always 200 unless the server is
 *                       actively crashing. Used as liveness probe.
 *   GET /health/ready   we can serve real traffic — DB reachable, etc.
 *                       Used as readiness probe (k8s) / hold-traffic
 *                       check during boot.
 *
 * Neither endpoint authenticates; the API is otherwise public to its
 * load balancer.
 */

import type { FastifyInstance } from "fastify";

const startedAt = new Date();

export async function healthRoutes(app: FastifyInstance) {
  // Liveness — always cheap, never touches dependencies. The process is
  // up if this responds; orchestrator should restart the pod if it doesn't.
  app.get("/health/live", async () => ({
    ok: true,
    service: "smart-loan-api",
    uptimeMs: Date.now() - startedAt.getTime(),
  }));

  // Readiness — pings the DB. If we can't reach Postgres, we return 503
  // and the load balancer will pull us out of rotation until we recover.
  // Keep this very cheap (`SELECT 1`) — readiness gets hit frequently.
  app.get("/health/ready", async (_req, reply) => {
    const checks: Record<
      string,
      { ok: boolean; latencyMs?: number; error?: string }
    > = {};

    // DB ping
    const t0 = Date.now();
    try {
      await app.prisma.$queryRaw`SELECT 1`;
      checks.database = { ok: true, latencyMs: Date.now() - t0 };
    } catch (err) {
      checks.database = {
        ok: false,
        latencyMs: Date.now() - t0,
        error: (err as Error).message,
      };
    }

    const ok = Object.values(checks).every((c) => c.ok);
    if (!ok) reply.code(503);
    return { ok, checks };
  });

  // Legacy alias preserved so existing probes / monitors keep working.
  app.get("/health", async () => ({ ok: true, service: "smart-loan-api" }));
}
