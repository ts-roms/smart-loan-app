import { hashPassword } from "@loan/auth";
import {
  type AuditLogRepository,
  type PrismaClient,
  type RoleRepository,
} from "@loan/db";

import {
  bulkUserRowSchema,
  type BulkUserRowInput,
  type UserBulkImportInput,
} from "./schemas.js";

/**
 * Output row in the bulk-import response. Successful real-run rows
 * carry the created user id + email; dry-run successes omit the id
 * because nothing was created. Failed rows carry the error message.
 */
export type UserBulkRow =
  | { index: number; ok: true; id?: string; email: string }
  | { index: number; ok: false; error: string };

export interface UserBulkResult {
  results: UserBulkRow[];
  succeeded: number;
  failed: number;
  dryRun: boolean;
}

/**
 * Bulk user onboarding. Two phases mirror the customer bulk-import:
 *
 *   1. Validate every row against `bulkUserRowSchema`. Bad rows never
 *      touch the DB; their error message is captured at the original
 *      CSV index.
 *   2. (Real run only) check for email collisions, hash passwords,
 *      create the User row, and apply secondary role assignments. A
 *      single failed row does NOT roll back earlier successful rows
 *      — partial success is the expected mode for ops that want to
 *      "let me see who got in, fix the rest by hand".
 *
 * `stopOnError:true` short-circuits the validation loop (same
 * semantics as the customer importer). `dryRun:true` skips phase 2
 * entirely.
 *
 * Audit log: a single `BULK_USER_IMPORT` row is recorded at the end
 * (not per user) — every successful user already gets a `USER_CREATE`
 * row from the create path. The bulk row carries the counts so
 * compliance can see "how many were onboarded in one operation".
 */
export class UsersBulkImportService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly roles: RoleRepository,
    private readonly audit: AuditLogRepository,
  ) {}

  async run(args: {
    input: UserBulkImportInput;
    actorId: string;
  }): Promise<UserBulkResult> {
    const { rows, stopOnError, dryRun } = args.input;
    const validated = this.validateRows(rows, stopOnError);

    if (dryRun) {
      const results: UserBulkRow[] = validated.map((v) =>
        v.ok
          ? { index: v.index, ok: true, email: v.data.email }
          : { index: v.index, ok: false, error: v.error },
      );
      const succeeded = results.filter((r) => r.ok).length;
      return {
        results,
        succeeded,
        failed: results.length - succeeded,
        dryRun: true,
      };
    }

    const result = await this.commit(validated, args.actorId, stopOnError);

    // Single audit row summarising the batch. Per-user USER_CREATE
    // rows are still emitted by the create path so the audit trail
    // remains row-level.
    await this.audit.record({
      action: "BULK_USER_IMPORT",
      actorId: args.actorId,
      targetType: "User",
      payload: {
        requested: rows.length,
        succeeded: result.succeeded,
        failed: result.failed,
      },
    });
    return result;
  }

  /** Phase 1: zod-validate each row with optional early stop. */
  private validateRows(
    rows: Array<Record<string, unknown>>,
    stopOnError: boolean,
  ) {
    type ValidatedRow =
      | { ok: true; index: number; data: BulkUserRowInput }
      | { ok: false; index: number; error: string };

    const out: ValidatedRow[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = bulkUserRowSchema.safeParse(rows[i]);
      if (r.success) {
        out.push({ ok: true, index: i, data: r.data });
      } else {
        const first = r.error.issues[0];
        const msg = first
          ? `${first.path.join(".") || "row"}: ${first.message}`
          : "Validation failed";
        out.push({ ok: false, index: i, error: msg });
        if (stopOnError) break;
      }
    }
    return out;
  }

  /**
   * Phase 2: persist each validated row in CSV order. Email collision
   * + customer-link checks happen per-row so the partial-success
   * semantics work without needing the whole batch in a transaction.
   */
  private async commit(
    validated: Array<
      | { ok: true; index: number; data: BulkUserRowInput }
      | { ok: false; index: number; error: string }
    >,
    actorId: string,
    stopOnError: boolean,
  ): Promise<UserBulkResult> {
    const results: UserBulkRow[] = [];
    for (const row of validated) {
      if (!row.ok) {
        results.push({ index: row.index, ok: false, error: row.error });
        continue;
      }
      const { data } = row;
      try {
        // Email collision check — same as createUser.
        const exists = await this.prisma.user.findUnique({
          where: { email: data.email },
        });
        if (exists) {
          throw new Error(`Email already in use: ${data.email}`);
        }

        // CUSTOMER + customerId: same 1:1 invariant as createUser.
        if (data.role === "CUSTOMER" && data.customerId) {
          const customer = await this.prisma.customer.findUnique({
            where: { id: data.customerId },
            include: { user: { select: { id: true } } },
          });
          if (!customer)
            throw new Error(`Customer not found: ${data.customerId}`);
          if (customer.user)
            throw new Error(
              `Customer already linked to a user: ${data.customerId}`,
            );
        }

        const user = await this.prisma.user.create({
          data: {
            email: data.email,
            name: data.name,
            passwordHash: await hashPassword(data.password),
            role: data.role,
            customerId:
              data.role === "CUSTOMER" && data.customerId
                ? data.customerId
                : undefined,
          },
          select: { id: true, email: true },
        });

        // Apply optional extra roles. Each call is audit-coupled via
        // the repo; failures here don't roll back the user itself
        // (worth it; the user can log in even if a secondary role
        // didn't attach).
        for (const roleKey of data.extraRoles) {
          try {
            await this.roles.assign(user.id, roleKey, actorId);
          } catch (assignErr) {
            // Surface the partial-failure as the row's error but
            // still mark the user created.
            const msg = (assignErr as Error).message;
            results.push({
              index: row.index,
              ok: false,
              error: `User created but role "${roleKey}" not assigned: ${msg}`,
            });
            // Don't break; user is in. Continue to next row.
          }
        }

        // If we already pushed a partial-failure row above for this
        // index, don't double-push the success.
        if (!results.some((r) => r.index === row.index)) {
          results.push({
            index: row.index,
            ok: true,
            id: user.id,
            email: user.email,
          });
        }
      } catch (err) {
        results.push({
          index: row.index,
          ok: false,
          error: (err as Error).message,
        });
        if (stopOnError) break;
      }
    }

    // Re-sort by original index in case secondary-role failures
    // interleaved out of order.
    results.sort((a, b) => a.index - b.index);
    const succeeded = results.filter((r) => r.ok).length;
    return {
      results,
      succeeded,
      failed: results.length - succeeded,
      dryRun: false,
    };
  }
}
