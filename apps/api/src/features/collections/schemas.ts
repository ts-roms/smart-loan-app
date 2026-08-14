import { z } from "zod";

/**
 * Collections request shapes. Notes capture interactions with the
 * borrower (call/SMS/email/visit); promises-to-pay (PTPs) are
 * lightweight forecasts the borrower commits to. Resolution updates
 * the PTP's terminal state.
 */

export const noteSchema = z.object({
  type: z.enum(["CALL", "SMS", "EMAIL", "VISIT", "OTHER"]).default("OTHER"),
  body: z.string().min(1).max(2000),
});
export type NoteInput = z.infer<typeof noteSchema>;

export const ptpSchema = z.object({
  amount: z.number().positive(),
  promisedDate: z.string(),
  note: z.string().max(500).optional(),
});
export type PtpInput = z.infer<typeof ptpSchema>;

export const resolveSchema = z.object({
  status: z.enum(["HONORED", "BROKEN", "CANCELLED"]),
});
export type ResolveInput = z.infer<typeof resolveSchema>;

/**
 * Hand an account to a collector, or move it to a different one.
 *
 * `collector` takes a user UUID or an email address. Requiring the UUID
 * meant every caller had to look one up first, and made a bulk
 * reassignment script — or the audit payload it produces — unreadable.
 * The UI picker keeps sending ids; a human writing curl can send
 * "ana@coop.local".
 *
 * Kept as one field rather than collectorId/collectorEmail: two
 * optional fields need a refinement to reject both-or-neither, and
 * callers then have to decide which to populate for an identifier they
 * are just passing through.
 */
export const assignSchema = z.object({
  collector: z.union([z.string().uuid(), z.string().email()]),
  note: z.string().max(500).optional(),
});
export type AssignInput = z.infer<typeof assignSchema>;

/**
 * Bulk assignment — one collector, many accounts. Capped at 500 like
 * the other batch endpoints; the queue itself is far smaller in any
 * sane book, and a runaway client shouldn't be able to queue thousands
 * of upserts in one transaction.
 */
export const bulkAssignSchema = z.object({
  loanIds: z.array(z.string().uuid()).min(1).max(500),
  collector: z.union([z.string().uuid(), z.string().email()]),
  note: z.string().max(500).optional(),
});
export type BulkAssignInput = z.infer<typeof bulkAssignSchema>;

/**
 * Queue scope.
 *
 *   all         every delinquent account (the existing shared worklist)
 *   mine        only the caller's own — the collector dashboard
 *   unassigned  the pool a supervisor hands out from
 *
 * `mine` resolves to the caller's own id server-side and never accepts
 * a collectorId from the client: letting the caller name whose queue to
 * read would turn a collector's own-accounts view into a way to read
 * everyone else's book.
 */
export const queueScopeSchema = z.object({
  scope: z.enum(["all", "mine", "unassigned"]).default("all"),
  /**
   * Borrower area, matched case-insensitively and exactly.
   *
   * Server-side since the queue became paginated. It used to be a
   * client-side filter over the whole worklist, which was correct only
   * because the endpoint returned all of it; filtering one page is not
   * filtering the book, and a collector narrowing to a province would
   * have silently seen only the accounts from that province that
   * happened to land on the current page.
   */
  province: z.string().max(120).optional(),
  city: z.string().max(120).optional(),
  /*
   * Declared, or Fastify's AJV strips them.
   *
   * `routeSchema` compiles the querystring with `additionalProperties:
   * false` and `removeAdditional`, so a parameter that is not named here
   * is deleted from `req.query` before the handler runs — no error, the
   * page just silently reverts to the first one. Left loosely bounded on
   * purpose, as on the other list endpoints: the repository clamps, so a
   * stale `?page=0` bookmark lands on page 1 rather than on a 400.
   */
  page: z.coerce.number().optional(),
  pageSize: z.coerce.number().optional(),
});
export type QueueScope = z.infer<typeof queueScopeSchema>;

/* ─── Request params, for the OpenAPI spec ──────────────────────────────
 *
 * `:loanId` is deliberately not `.uuid()`: the assignment and unassign
 * paths resolve loan numbers too (idOrNumberWhere in the service), and
 * the note/promise paths accept whatever string arrives today.
 */
export const loanIdParamSchema = z.object({
  loanId: z.string().min(1),
});

export const promiseIdParamSchema = z.object({
  id: z.string().min(1),
});

/* ─── Response shapes, for the OpenAPI spec ─────────────────────────────
 *
 * zod so they are real parsers a test can assert payloads against; they
 * declare what is CONTRACTUAL and let the rest pass through (see
 * lib/openapi.ts). Money rules: columns straight off a Prisma row are
 * Decimal STRINGS (`PromiseToPay.amount`, the queue row's `principal`);
 * figures folded in JS (`outstanding`) are numbers.
 */

/** The collector working an account, flattened onto a queue row. */
const queueAssigneeSchema = z.object({
  collectorId: z.string().uuid(),
  collectorName: z.string(),
  assignedAt: z.string().datetime(),
  note: z.string().nullable(),
});

/**
 * §29 priority verdict carried on every queue row — the score, its
 * factor breakdown, and the recommended next move.
 */
const prioritySchema = z.object({
  /** 0–100. Higher means work it sooner. */
  score: z.number(),
  band: z.string(),
  agingBucket: z.string(),
  /** Per-factor contribution, so the ordering is arguable. */
  factors: z.array(
    z.object({
      factorId: z.string(),
      label: z.string(),
      weight: z.number(),
      strength: z.number(),
      points: z.number(),
      source: z.string(),
    }),
  ),
  action: z.string(),
  actionReason: z.string(),
  channel: z.string(),
  channelReason: z.string(),
  nextFollowUpDate: z.string().datetime(),
  followUpReason: z.string(),
  /** True when a terminal account is deliberately pushed down the queue. */
  suppressed: z.boolean(),
});

/**
 * One delinquent account. The loan row's own columns (Decimal strings,
 * datetimes) ride along; the queue-specific figures are JS numbers.
 */
export const queueRowResponseSchema = z.object({
  id: z.string().uuid(),
  number: z.string(),
  customerId: z.string().uuid(),
  productCode: z.string(),
  /** Decimal on the wire. */
  principal: z.string(),
  status: z.string(),
  customerName: z.string(),
  /** Borrower's area — drives the queue's area filter. */
  customerCity: z.string(),
  customerProvince: z.string().nullable(),
  /** Days the EARLIEST unpaid instalment is past due. Exact. */
  daysOverdue: z.number().int(),
  outstanding: z.number(),
  overdueCount: z.number().int(),
  assignee: queueAssigneeSchema.nullable(),
  priority: prioritySchema,
});

/**
 * The queue, one page at a time.
 *
 * Was a bare array. It is now the house offset envelope
 * (`libs/db/src/lib/pagination.ts`) plus `areas`, because the endpoint
 * returned the entire delinquent book on every request — finding F4 in
 * docs/modernization/query-performance.md.
 *
 * `rows` is a window onto the queue's GLOBAL ranking, not a re-ranked
 * subset: every eligible account is still scored and ordered against
 * every other one before the window is cut. Row 1 of page 1 is the same
 * account it was before this change. See `overdueQueuePage` for why the
 * ordering cannot be pushed into SQL, and what it would take to do it.
 *
 * `total` is the size of the whole filtered queue, so a UI can say
 * "50 of 812" rather than mistaking a page for the book.
 */
export const queueResponseSchema = z.object({
  rows: z.array(queueRowResponseSchema),
  /** Accounts matching the filter across all pages — not rows.length. */
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  /** At least 1 even when nothing matched. */
  totalPages: z.number().int(),
  /**
   * Distinct areas across the caller's whole scope, for the filter
   * control. Derived from the unfiltered scope rather than the current
   * page or the current filter, so the dropdown neither hides the rest
   * of a collector's book nor collapses to the value already chosen.
   */
  areas: z.object({
    provinces: z.array(z.string()),
    cities: z.array(z.string()),
  }),
});

/** Users who can hold accounts — the assign picker. */
export const collectorListResponseSchema = z.array(
  z.object({
    id: z.string().uuid(),
    name: z.string(),
    email: z.string(),
    role: z.string(),
  }),
);

/** Accounts carried per collector, busiest first. */
export const workloadResponseSchema = z.array(
  z.object({
    collectorId: z.string().uuid(),
    collectorName: z.string(),
    accounts: z.number().int(),
  }),
);

/** The assignment row after an assign/reassign. */
export const assignmentResponseSchema = z.object({
  id: z.string().uuid(),
  loanId: z.string().uuid(),
  collectorId: z.string().uuid(),
  assignedById: z.string().uuid(),
  /** Refreshed on reassignment — "held since THIS collector got it". */
  assignedAt: z.string().datetime(),
  note: z.string().nullable(),
  collector: z.object({ id: z.string().uuid(), name: z.string() }),
});

/** Bulk assignment outcome — unknown ids reported, not fatal. */
export const bulkAssignResponseSchema = z.object({
  assigned: z.number().int(),
  missing: z.array(z.string()),
});

export const noteResponseSchema = z.object({
  id: z.string().uuid(),
  loanId: z.string().uuid(),
  type: z.enum(["CALL", "SMS", "EMAIL", "VISIT", "OTHER"]),
  body: z.string(),
  createdAt: z.string().datetime(),
  createdById: z.string().uuid(),
});

export const noteListResponseSchema = z.array(noteResponseSchema);

export const promiseResponseSchema = z.object({
  id: z.string().uuid(),
  loanId: z.string().uuid(),
  /** Decimal on the wire. */
  amount: z.string(),
  promisedDate: z.string().datetime(),
  status: z.enum(["PROMISED", "HONORED", "BROKEN", "CANCELLED"]),
  note: z.string().nullable(),
  createdAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
  createdById: z.string().uuid(),
});

export const promiseListResponseSchema = z.array(promiseResponseSchema);

/** Idempotent accrual: `posted` is new entries, `skipped` everything else. */
export const accrueLateFeesResponseSchema = z.object({
  posted: z.number().int(),
  skipped: z.number().int(),
});
