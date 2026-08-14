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
import { z } from "zod";

import { routeSchema } from "../../lib/openapi";

const startedAt = new Date();

const TAGS = ["health"];

/**
 * Response shapes, declared with zod so they are real parsers rather
 * than prose — a test can assert an actual payload against them.
 */
const liveResponse = z.object({
  ok: z.literal(true),
  service: z.string(),
  /** Since process start, not since the last request. */
  uptimeMs: z.number().int(),
});

const readyResponse = z.object({
  /** False when ANY check failed; the response is then a 503. */
  ok: z.boolean(),
  checks: z.record(
    z.object({
      ok: z.boolean(),
      latencyMs: z.number().optional(),
      error: z.string().optional(),
    }),
  ),
});

const legacyResponse = z.object({
  ok: z.literal(true),
  service: z.string(),
});

export async function healthRoutes(app: FastifyInstance) {
  // Liveness — always cheap, never touches dependencies. The process is
  // up if this responds; orchestrator should restart the pod if it doesn't.
  app.get(
    "/health/live",
    {
      schema: routeSchema({
        summary: "Liveness probe — the process is up.",
        tags: TAGS,
        public:
          "a probe runs before anything can hold a token, and a liveness " +
          "check that could fail on authentication would restart a " +
          "perfectly healthy pod.",
        response: liveResponse,
      }),
    },
    async () => ({
      ok: true,
      service: "smart-loan-api",
      uptimeMs: Date.now() - startedAt.getTime(),
    }),
  );

  // Readiness — pings the DB. If we can't reach Postgres, we return 503
  // and the load balancer will pull us out of rotation until we recover.
  // Keep this very cheap (`SELECT 1`) — readiness gets hit frequently.
  app.get(
    "/health/ready",
    {
      schema: routeSchema({
        summary: "Readiness probe — dependencies are reachable.",
        tags: TAGS,
        public:
          "the load balancer calls it with no credentials. Answers 503, " +
          "not an error body, when a dependency is unreachable.",
        response: readyResponse,
      }),
    },
    async (_req, reply) => {
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
    },
  );

  // Legacy alias preserved so existing probes / monitors keep working.
  app.get(
    "/health",
    {
      schema: routeSchema({
        summary: "Legacy alias for /health/live.",
        tags: TAGS,
        public: "same as /health/live, which existing probes still call.",
        response: legacyResponse,
      }),
    },
    async () => ({ ok: true, service: "smart-loan-api" }),
  );
}
