/**
 * Job scheduler persistence + runtime. The job *functions* live in the API
 * package (so they can reference the LoanRepository, AccountingRepository,
 * etc.); we only know about persistence here.
 *
 * Public surface:
 *   - register(jobs)        — upsert ScheduledJob rows for a list of definitions
 *   - list / find           — read
 *   - start(jobs)           — kick off the interval-based tick loop
 *   - runNow(name, jobs, manual=true) — manual trigger
 *
 * Each run is wrapped in a JobRun record so the UI can show history,
 * durations, and failure reasons.
 */

import {
  type JobDefinition,
  type JobContext,
  cronIsValid,
  parseNextRun,
} from "@loan/jobs";
import type {
  JobRun,
  JobStatus,
  PrismaClient,
  ScheduledJob,
} from "@prisma/client";

export class JobRepository {
  /** Tick interval. 60s is plenty; cron precision is per-minute anyway. */
  private static readonly TICK_MS = 60_000;

  private intervalRef: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaClient) {}

  list(): Promise<ScheduledJob[]> {
    return this.prisma.scheduledJob.findMany({ orderBy: { name: "asc" } });
  }

  findByName(name: string): Promise<ScheduledJob | null> {
    return this.prisma.scheduledJob.findUnique({ where: { name } });
  }

  listRuns(jobId: string, take = 50): Promise<JobRun[]> {
    return this.prisma.jobRun.findMany({
      where: { jobId },
      orderBy: { startedAt: "desc" },
      take,
    });
  }

  /** Idempotent. Adds rows for new job names; never overwrites cron edits. */
  async register(jobs: JobDefinition[]): Promise<void> {
    for (const j of jobs) {
      if (!cronIsValid(j.defaultCron)) {
        throw new Error(`Invalid cron for job ${j.name}: ${j.defaultCron}`);
      }
      await this.prisma.scheduledJob.upsert({
        where: { name: j.name },
        create: {
          name: j.name,
          description: j.description,
          cron: j.defaultCron,
          nextRunAt: parseNextRun(j.defaultCron),
        },
        update: {}, // do not stomp existing cron
      });
    }
  }

  async updateCron(name: string, cron: string): Promise<ScheduledJob> {
    if (!cronIsValid(cron)) throw new Error(`Invalid cron: ${cron}`);
    return this.prisma.scheduledJob.update({
      where: { name },
      data: { cron, nextRunAt: parseNextRun(cron) },
    });
  }

  async setEnabled(name: string, enabled: boolean): Promise<ScheduledJob> {
    return this.prisma.scheduledJob.update({
      where: { name },
      data: { enabled },
    });
  }

  /**
   * Run one job. Persists `JobRun`, updates `lastRunAt`/`nextRunAt`.
   * Never throws — failures land in `error`.
   */
  async runOne(
    name: string,
    fn: JobDefinition["fn"],
    opts: { manual?: boolean } = {},
  ): Promise<JobRun> {
    const job = await this.findByName(name);
    if (!job) throw new Error(`Job ${name} is not registered.`);
    const run = await this.prisma.jobRun.create({
      data: {
        jobId: job.id,
        status: "RUNNING" as JobStatus,
        manual: opts.manual ?? false,
      },
    });
    const ctx: JobContext = {
      runId: run.id,
      startedAt: run.startedAt,
      manual: run.manual,
    };
    try {
      const result = await fn(ctx);
      await this.prisma.scheduledJob.update({
        where: { id: job.id },
        data: { lastRunAt: new Date(), nextRunAt: parseNextRun(job.cron) },
      });
      return this.prisma.jobRun.update({
        where: { id: run.id },
        data: {
          status: "SUCCEEDED" as JobStatus,
          finishedAt: new Date(),
          result: (result as never) ?? undefined,
        },
      });
    } catch (err) {
      await this.prisma.scheduledJob.update({
        where: { id: job.id },
        data: { lastRunAt: new Date(), nextRunAt: parseNextRun(job.cron) },
      });
      return this.prisma.jobRun.update({
        where: { id: run.id },
        data: {
          status: "FAILED" as JobStatus,
          finishedAt: new Date(),
          error: (err as Error).message,
        },
      });
    }
  }

  /**
   * One scheduler tick: find every enabled job whose `nextRunAt` is in
   * the past and fire it. Catch-up after an outage is intentionally
   * cheap — a job that should have fired during a 5-minute downtime
   * runs once when the scheduler comes back, not N times.
   *
   * Public so a higher-level orchestrator (e.g. the multi-tenant
   * scheduler that fans out across schemas) can call it per tenant
   * without owning its own interval.
   */
  async tickDueJobs(defs: JobDefinition[]): Promise<void> {
    const byName = new Map(defs.map((d) => [d.name, d]));
    const now = new Date();
    const due = await this.prisma.scheduledJob.findMany({
      where: { enabled: true, nextRunAt: { lte: now } },
    });
    for (const job of due) {
      const def = byName.get(job.name);
      if (!def) continue;
      await this.runOne(job.name, def.fn, { manual: false }).catch(() => {});
    }
  }

  /**
   * Start an internal interval that ticks this repository's schema.
   * Use only for single-tenant deployments; multi-tenant deployments
   * should let `TenantScheduler` own the interval and call
   * `tickDueJobs` per tenant.
   */
  start(defs: JobDefinition[]): void {
    if (this.intervalRef) return;
    // Fire once right away to handle any catch-up at process boot.
    this.tickDueJobs(defs).catch(() => {});
    this.intervalRef = setInterval(() => {
      this.tickDueJobs(defs).catch(() => {});
    }, JobRepository.TICK_MS);
  }

  stop(): void {
    if (this.intervalRef) clearInterval(this.intervalRef);
    this.intervalRef = null;
  }
}
