/**
 * Audit log — append-only record of privileged actions.
 *
 * Any route that mutates significant state should call `record()` with the
 * coarse action label, the actor id from the JWT, and an optional payload.
 * Never throws; logging failures are non-fatal.
 *
 * ## Impersonation
 *
 * When the call is coming from a platform-impersonated session (the
 * JWT carries an `impersonatedBy` claim), the repository stamps every
 * row with the impersonator's platform user id + email. Two paths:
 *
 *   1. **Default-via-constructor (recommended).** Per-request
 *      preHandlers build the repo with the caller's `req.user`; every
 *      `record()` automatically picks up the impersonator. Services
 *      themselves don't need to know impersonation exists.
 *
 *   2. **Per-call override.** A `record()` call can pass an explicit
 *      `impersonatedBy` (or `null` to suppress the default). Rare —
 *      useful when one service records on behalf of another actor.
 *
 * Compliance can run "what did vendor support do against tenant X?"
 * by filtering on `impersonatedByEmail` alone.
 *
 * ## Request context (§56)
 *
 * §56 wants tenant, IP, user agent and a request id on every audit row.
 * None of those are knowable inside libs/db, which has no Fastify
 * dependency and is not getting one — `req.ip` cannot be read here.
 *
 * They arrive the same way the impersonator already does: as a plain
 * data object handed to the constructor by the per-request factory that
 * builds this repository. `AuditRequestContext` is four optional
 * strings; it names nothing from Fastify and could equally be filled in
 * by a CLI, a job runner, or a test.
 *
 * The alternative — threading ip/ua/requestId down as arguments to
 * `record()` — was rejected. The services that call `record()`
 * (LoanWorkflowService, JournalService, AuthService, …) sit several
 * frames below the route and know nothing about requests; making the
 * context a call argument would mean widening every method signature
 * along each of those paths, and every one of them would be a place to
 * forget. Fields that are present but null on the call sites that
 * matter are worse than absent fields, because they read as solved. The
 * constructor seam populates them for every existing call site at once,
 * without touching a single service.
 *
 * A per-call `context` override exists for the same reason the
 * impersonator has one: a job that records on behalf of a request it
 * did not serve should not inherit that request's IP.
 *
 * ## Failure handling
 *
 * `record()` is best-effort by default and returns null on failure —
 * that is the existing contract for the two dozen call sites already
 * relying on it, and it is the right default for a product edit or a
 * report export.
 *
 * `record({ required: true })` instead lets the error propagate, so a
 * failed audit write aborts the caller's transaction. That is the mode
 * the money path uses; see `recordRequired()` and the reasoning there.
 *
 * Failures are reported through an injected logger (pino, in the API)
 * rather than `console.error`, so they land in the same structured
 * stream as everything else and are actually alertable.
 */

import type { AuditEvent, Prisma, PrismaClient } from "@prisma/client";

type Tx = Prisma.TransactionClient | PrismaClient;

/**
 * Shape of the JWT `impersonatedBy` claim. Same as the one defined in
 * `@loan/auth` types; redefined here so libs/db doesn't carry an
 * @loan/auth dependency.
 */
export interface AuditImpersonator {
  platformUserId: string;
  platformUserEmail: string;
  purpose?: string;
}

/**
 * The §56 provenance fields, as plain data.
 *
 * Deliberately free of any Fastify type. `apps/api` extracts these from
 * a request once (see `auditContextOf` in apps/api/src/lib/audit-context.ts);
 * libs/db only ever sees this shape.
 */
export interface AuditRequestContext {
  /** Tenant slug the action was performed against (`req.tenantCtx.slug`). */
  tenantId?: string | null;
  /** Client IP as the server saw it (`req.ip`). */
  ipAddress?: string | null;
  /** Raw `User-Agent` header. Truncated to 512 chars on write. */
  userAgent?: string | null;
  /** Correlation id for the causing request (`req.id`). */
  requestId?: string | null;
}

/**
 * The slice of pino this repository needs. Structural, so `app.log`
 * satisfies it without libs/db depending on pino or on Fastify.
 */
export interface AuditLogger {
  error(obj: Record<string, unknown>, msg: string): void;
}

/** `User-Agent` is attacker-controlled and unbounded; cap what we store. */
const USER_AGENT_MAX = 512;

export interface AuditEventInput {
  action: string;
  actorId: string;
  targetType?: string;
  targetId?: string;
  payload?: unknown;
  tx?: Tx;
  /**
   * Per-call override. Defaults to the repo's `defaultImpersonator`
   * when omitted. Pass `null` explicitly to suppress the default (one
   * service recording on behalf of someone else — e.g. an automated
   * job).
   */
  impersonatedBy?: AuditImpersonator | null;
  /**
   * Per-call override for the request provenance, same semantics as
   * `impersonatedBy`: omitted means "use the repo's context", explicit
   * `null` means "record no context" (a job that must not inherit the
   * IP of whatever request happened to enqueue it).
   */
  context?: AuditRequestContext | null;
  /** State before the action. Omit for creates. */
  oldValue?: unknown;
  /** State after the action. Omit for deletes. */
  newValue?: unknown;
  /** Operator-supplied justification, where the action collects one. */
  reason?: string | null;
  /**
   * When true, a failed audit write throws instead of returning null,
   * aborting the caller's transaction. Use for privileged financial
   * actions — see `recordRequired()`.
   */
  required?: boolean;
}

export class AuditLogRepository {
  /**
   * @param prisma                  Tenant-bound Prisma client.
   * @param defaultImpersonator     Optional. When the per-request factory
   *                                passes the caller's JWT impersonator
   *                                here, every audit row inherits it
   *                                automatically. Null/undefined leaves
   *                                rows unmarked.
   */
  private readonly defaultContext: AuditRequestContext | null;
  private readonly logger: AuditLogger;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly defaultImpersonator?: AuditImpersonator | null,
    /**
     * Third parameter is an options bag rather than two more positional
     * arguments so the two dozen existing `new AuditLogRepository(prisma,
     * req.user?.impersonatedBy)` call sites keep compiling untouched.
     */
    options?: {
      /** Per-request §56 provenance. See `AuditRequestContext`. */
      context?: AuditRequestContext | null;
      /** Where write failures go. Defaults to `console.error`. */
      logger?: AuditLogger;
    },
  ) {
    this.defaultContext = options?.context ?? null;
    this.logger = options?.logger ?? {
      // Fallback for the paths that have no logger to give (scripts,
      // tests, the platform service's cross-tenant writes). The API
      // always injects app.log.
      error: (obj, msg) => console.error(msg, obj),
    };
  }

  /**
   * Record an event that the caller's transaction depends on.
   *
   * Identical to `record()` except that a write failure propagates
   * instead of being logged and swallowed, so the enclosing transaction
   * rolls back with it.
   *
   * ## Why the money path fails closed
   *
   * §56 requires that every sensitive action is audited and that audit
   * records are append-only. An action that succeeded without leaving a
   * record is not a degraded audit trail — it is an undetectable one,
   * because nothing downstream can tell "this disbursement was never
   * audited" apart from "this disbursement never happened". The gap is
   * invisible precisely where it matters most.
   *
   * The cost of failing closed is a refused disbursement. The cost of
   * failing open is an untraceable one. For a privileged financial
   * action those are not comparable: the refusal is visible, retryable
   * and safe, and it happens only when the database is already sick
   * enough that the money write was likely doomed anyway — the audit
   * row is written on the *same connection, inside the same
   * transaction* as the ledger rows, so the realistic failure modes
   * (connection lost, disk full, deadlock) would take the business
   * write down regardless. The narrow case where the audit insert alone
   * fails is a schema/constraint bug, and shipping money on a broken
   * audit schema is exactly what §56 exists to prevent.
   *
   * This is NOT made the default. For a product edit or a report
   * export the trade runs the other way — best-effort logging is
   * correct there, and flipping the default would change the failure
   * behaviour of two dozen call sites that were never reviewed for it.
   * Fail-closed is opt-in, and the money path opts in.
   */
  recordRequired(
    input: Omit<AuditEventInput, "required">,
  ): Promise<AuditEvent | null> {
    return this.record({ ...input, required: true });
  }

  async record(input: AuditEventInput): Promise<AuditEvent | null> {
    const client = input.tx ?? this.prisma;
    // `undefined` means "use the default"; explicit `null` means
    // "no impersonator" even if the repo has a default. Important for
    // job-driven writes that shouldn't be tagged with whoever
    // happened to trigger the parent request.
    const imp =
      input.impersonatedBy === undefined
        ? (this.defaultImpersonator ?? null)
        : input.impersonatedBy;
    // Same three-state rule for the request context.
    const ctx =
      input.context === undefined ? this.defaultContext : input.context;
    try {
      return await client.auditEvent.create({
        data: {
          action: input.action,
          actorId: input.actorId,
          targetType: input.targetType,
          targetId: input.targetId,
          payload:
            (input.payload as Prisma.InputJsonValue | undefined) ?? undefined,
          impersonatedById: imp?.platformUserId,
          impersonatedByEmail: imp?.platformUserEmail,
          tenantId: ctx?.tenantId ?? undefined,
          ipAddress: ctx?.ipAddress ?? undefined,
          userAgent: ctx?.userAgent?.slice(0, USER_AGENT_MAX) ?? undefined,
          requestId: ctx?.requestId ?? undefined,
          oldValue:
            (input.oldValue as Prisma.InputJsonValue | undefined) ?? undefined,
          newValue:
            (input.newValue as Prisma.InputJsonValue | undefined) ?? undefined,
          reason: input.reason ?? undefined,
        },
      });
    } catch (err) {
      // Structured, so it lands in the same stream as every other API
      // log line and can be alerted on. The requestId is included
      // explicitly: it is the join key back to the request that lost
      // its audit row.
      this.logger.error(
        {
          err,
          action: input.action,
          actorId: input.actorId,
          targetType: input.targetType,
          targetId: input.targetId,
          requestId: ctx?.requestId ?? undefined,
          required: input.required === true,
        },
        "[audit] failed to record event",
      );
      // Privileged financial actions fail closed — the caller's
      // transaction must not commit money without its audit row.
      if (input.required) throw err;
      return null;
    }
  }

  list(filter?: {
    actorId?: string;
    action?: string;
    targetType?: string;
    targetId?: string;
    impersonatedById?: string;
    impersonatedByEmail?: string;
    /** Everything that happened under one HTTP request — the support query. */
    requestId?: string;
    /** Everything that came from one origin — the forensics query. */
    ipAddress?: string;
    from?: Date;
    to?: Date;
    take?: number;
  }): Promise<AuditEvent[]> {
    return this.prisma.auditEvent.findMany({
      where: {
        actorId: filter?.actorId,
        action: filter?.action,
        targetType: filter?.targetType,
        targetId: filter?.targetId,
        impersonatedById: filter?.impersonatedById,
        impersonatedByEmail: filter?.impersonatedByEmail,
        requestId: filter?.requestId,
        ipAddress: filter?.ipAddress,
        createdAt: {
          gte: filter?.from,
          lte: filter?.to,
        },
      },
      orderBy: { createdAt: "desc" },
      take: filter?.take ?? 200,
    });
  }
}
