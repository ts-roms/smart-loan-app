/**
 * Multi-tenant job scheduler.
 *
 * One process-level interval orchestrates background jobs across every
 * active tenant. Each tick:
 *
 *   1. Lists ACTIVE tenants from the platform schema. Single-tenant
 *      mode short-circuits to `[defaultSlug]`.
 *   2. For each tenant slug, gets the cached `PrismaClient` bound to
 *      `tenant_<slug>` (or `app.prisma` in single-tenant mode).
 *   3. Calls a caller-provided factory to build the job definitions
 *      using THAT tenant's prisma (so each tenant has its own
 *      `NotificationRepository`, `ScreeningRepository`, etc.).
 *   4. Lazily upserts `ScheduledJob` rows in the tenant schema the
 *      first time we see the slug (idempotent — never stomps cron
 *      edits an operator may have made).
 *   5. Calls `JobRepository.tickDueJobs(defs)` against the tenant's
 *      prisma — running anything whose `nextRunAt` has elapsed.
 *
 * The interval lives only here; per-tenant `JobRepository` instances
 * never start their own. This avoids one-interval-per-tenant pile-up
 * (which would also produce stampedes when 50 tenants all fire the
 * same cron expression at the same minute).
 *
 * @see docs/multi-tenant-implementation.md §6
 */

import type { JobDefinition } from "@loan/jobs";
import type { PrismaClient } from "@prisma/client";

import { JobRepository } from "./repositories/job.repository";
import type { TenantPrismaCache } from "./tenant-cache";

interface SchedulerLogger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

export interface TenantSchedulerOptions {
  /** Platform Prisma client — used to list tenants in multi-tenant mode. */
  platformPrisma: PrismaClient;
  /** Per-tenant client cache. Ignored in single-tenant mode. */
  tenantCache: TenantPrismaCache;
  /** Switches between single-tenant fallback and multi-tenant fan-out. */
  multiTenant: boolean;
  /** Slug used in single-tenant mode. Default "default". */
  defaultSlug?: string;
  /**
   * Builds the job definitions for a given tenant's prisma. Called once
   * per tick per tenant — keep it cheap (just constructor calls).
   */
  buildJobDefinitions: (prisma: PrismaClient) => JobDefinition[];
  log: SchedulerLogger;
  /** Tick interval in ms. Default 60_000 (one minute). */
  tickIntervalMs?: number;
}

export class TenantScheduler {
  private static readonly DEFAULT_TICK_MS = 60_000;

  private intervalRef: NodeJS.Timeout | null = null;
  /** Slugs we've already upserted ScheduledJob rows for this process. */
  private readonly registeredSlugs = new Set<string>();

  private readonly platformPrisma: PrismaClient;
  private readonly tenantCache: TenantPrismaCache;
  private readonly multiTenant: boolean;
  private readonly defaultSlug: string;
  private readonly buildJobDefinitions: (
    prisma: PrismaClient,
  ) => JobDefinition[];
  private readonly log: SchedulerLogger;
  private readonly tickIntervalMs: number;

  constructor(opts: TenantSchedulerOptions) {
    this.platformPrisma = opts.platformPrisma;
    this.tenantCache = opts.tenantCache;
    this.multiTenant = opts.multiTenant;
    this.defaultSlug = opts.defaultSlug ?? "default";
    this.buildJobDefinitions = opts.buildJobDefinitions;
    this.log = opts.log;
    this.tickIntervalMs =
      opts.tickIntervalMs ?? TenantScheduler.DEFAULT_TICK_MS;
  }

  /**
   * Start the orchestrator. Idempotent. Fires once immediately for
   * catch-up; subsequent ticks are spaced by `tickIntervalMs`.
   */
  start(): void {
    if (this.intervalRef) return;
    // Run-and-swallow so a transient platform DB hiccup never kills
    // the scheduler.
    this.tickAll().catch((err: unknown) => {
      this.log.error({ err }, "TenantScheduler initial tick failed");
    });
    this.intervalRef = setInterval(() => {
      this.tickAll().catch((err: unknown) => {
        this.log.error({ err }, "TenantScheduler tick failed");
      });
    }, this.tickIntervalMs);
  }

  stop(): void {
    if (this.intervalRef) clearInterval(this.intervalRef);
    this.intervalRef = null;
  }

  /** Exposed for tests + the "/jobs/sync" admin trigger. */
  async tickAll(): Promise<void> {
    const slugs = await this.activeSlugs();
    for (const slug of slugs) {
      try {
        await this.tickTenant(slug);
      } catch (err) {
        // One bad tenant should never stop the fan-out — log and
        // continue with the rest.
        this.log.warn({ err, slug }, "TenantScheduler tenant tick failed");
      }
    }
  }

  private async activeSlugs(): Promise<string[]> {
    if (!this.multiTenant) return [this.defaultSlug];
    const rows = await this.platformPrisma.tenant.findMany({
      where: { status: "ACTIVE" },
      select: { slug: true },
    });
    return rows.map((r) => r.slug);
  }

  private async tickTenant(slug: string): Promise<void> {
    const prisma = this.multiTenant
      ? this.tenantCache.get(slug)
      : this.platformPrisma;
    const defs = this.buildJobDefinitions(prisma);
    const repo = new JobRepository(prisma);
    if (!this.registeredSlugs.has(slug)) {
      // First time we've ticked this tenant in this process. Upsert
      // the catalog of ScheduledJob rows (cron-edit-safe) so any newly
      // provisioned tenant gets the job definitions without manual
      // intervention.
      try {
        await repo.register(defs);
        this.registeredSlugs.add(slug);
      } catch (err) {
        // Common cause: the tenant schema isn't fully migrated yet
        // (e.g. just-provisioned, migrations still running). Don't
        // mark it as registered so the next tick retries.
        this.log.warn(
          { err, slug },
          "TenantScheduler: failed to register jobs for tenant",
        );
        return;
      }
    }
    await repo.tickDueJobs(defs);
  }

  /**
   * Drop a slug from the registration cache so the next tick re-runs
   * `register()`. Useful after a tenant runs a fresh migration that
   * adds new job definitions, or when a tenant is unsuspended.
   */
  forgetSlug(slug: string): void {
    this.registeredSlugs.delete(slug);
  }
}
