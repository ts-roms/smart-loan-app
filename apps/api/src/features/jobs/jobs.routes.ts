import { JobRepository } from "@loan/db";
import { cronIsValid, type JobDefinition } from "@loan/jobs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

const cronSchema = z.object({ cron: z.string().min(1).max(120) });
const enabledSchema = z.object({ enabled: z.boolean() });

/**
 * Jobs admin: see what's scheduled, when it last ran, trigger manually.
 *
 * Hand-edits via PATCH are honored at the next tick.
 */
export function jobRoutes(repo: JobRepository, defs: JobDefinition[]) {
  return async (app: FastifyInstance) => {
    const byName = new Map(defs.map((d) => [d.name, d]));
    app.addHook("preHandler", app.authenticate);

    app.get("/", async () => repo.list());

    app.get<{ Params: { name: string } }>("/:name/runs", async (req) => {
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
        return repo.updateCron(req.params.name, parsed.data.cron);
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
        return repo.setEnabled(req.params.name, parsed.data.enabled);
      },
    );

    /** Manual run — bypasses the schedule, still records a JobRun row. */
    app.post<{ Params: { name: string } }>(
      "/:name/run",
      { preHandler: app.requirePermission("jobs.run") },
      async (req, reply) => {
        const def = byName.get(req.params.name);
        if (!def) return reply.code(404).send({ error: "NotFound" });
        return repo.runOne(req.params.name, def.fn, { manual: true });
      },
    );
  };
}
