/**
 * Jobs admin routes — see what's scheduled, when it last ran, trigger
 * manually. Phase 2: tenant-scoped. Each request rebuilds the
 * `JobRepository` + job definitions against the caller's tenant
 * schema so admins of tenant A can only see/edit/run their own jobs.
 *
 * The platform-wide scheduler that fires `nextRunAt` cron-triggered
 * runs lives in `TenantScheduler` (routes/index.ts). These admin
 * routes share the same per-tenant definition builder so manual
 * triggers and cron-fired runs hit the same code paths.
 */

import type { JobRepository } from "@loan/db";
import { type JobDefinition, cronIsValid } from "@loan/jobs";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

const cronSchema = z.object({ cron: z.string().min(1).max(120) });
const enabledSchema = z.object({ enabled: z.boolean() });

declare module "fastify" {
  interface FastifyRequest {
    jobsCtx?: { repo: JobRepository; defs: JobDefinition[] };
  }
}

/**
 * `buildCtx` is a factory passed in from the registrar — it builds the
 * tenant-bound `JobRepository` + `JobDefinition[]` for a given request.
 * Lives outside the plugin so the build closure (which uses the
 * notification + screening factories from `app`) stays in one place.
 */
export function jobRoutes(
  buildCtx: (req: FastifyRequest) => {
    repo: JobRepository;
    defs: JobDefinition[];
  },
) {
  return async (app: FastifyInstance) => {
    app.addHook("preHandler", app.authenticate);
    app.addHook("preHandler", app.resolveTenant);
    app.addHook("preHandler", async (req: FastifyRequest) => {
      req.jobsCtx = buildCtx(req);
    });

    // `jobs.read` (ACCOUNTANT + ADMIN) on the read surface — the run
    // log exposes the tenant's operational schedule and failure
    // history. The configure / run routes below keep their own keys.
    const read = { preHandler: app.requirePermission("jobs.read") };

    app.get("/", read, async (req) => req.jobsCtx!.repo.list());

    app.get<{ Params: { name: string } }>("/:name/runs", read, async (req) => {
      const { repo } = req.jobsCtx!;
      const job = await repo.findByName(req.params.name);
      if (!job) return [];
      return repo.listRuns(job.id);
    });

    app.patch<{ Params: { name: string } }>(
      "/:name/cron",
      { preHandler: app.requirePermission("jobs.configure") },
      async (req, reply) => {
        const parsed = cronSchema.safeParse(req.body);
        if (!parsed.success) {
          return reply
            .code(400)
            .send({ error: "ValidationError", issues: parsed.error.issues });
        }
        if (!cronIsValid(parsed.data.cron)) {
          return reply
            .code(400)
            .send({ error: "BadCron", message: "Invalid cron expression" });
        }
        return req.jobsCtx!.repo.updateCron(req.params.name, parsed.data.cron);
      },
    );

    app.patch<{ Params: { name: string } }>(
      "/:name/enabled",
      { preHandler: app.requirePermission("jobs.configure") },
      async (req, reply) => {
        const parsed = enabledSchema.safeParse(req.body);
        if (!parsed.success) {
          return reply
            .code(400)
            .send({ error: "ValidationError", issues: parsed.error.issues });
        }
        return req.jobsCtx!.repo.setEnabled(
          req.params.name,
          parsed.data.enabled,
        );
      },
    );

    /** Manual run — bypasses the schedule, still records a JobRun row. */
    app.post<{ Params: { name: string } }>(
      "/:name/run",
      { preHandler: app.requirePermission("jobs.run") },
      async (req, reply) => {
        const { repo, defs } = req.jobsCtx!;
        const def = defs.find((d) => d.name === req.params.name);
        if (!def) return reply.code(404).send({ error: "NotFound" });
        return repo.runOne(req.params.name, def.fn, { manual: true });
      },
    );
  };
}
