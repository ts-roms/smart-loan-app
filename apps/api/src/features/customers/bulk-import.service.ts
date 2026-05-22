import type { CustomerRepository, ScreeningRepository } from "@loan/db";

import {
  customerSchema,
  type BulkImportInput,
  type CustomerWriteInput,
} from "./schemas";
import { toDateOrUndefined } from "./helpers";

/**
 * Output row in a bulk-import response. Successful real-run rows carry
 * the freshly-allocated id + CUST-... number; dry-run successes omit
 * both because nothing was created. Failed rows carry the validation
 * or persistence error message.
 */
export type BulkImportRow =
  | { index: number; ok: true; id?: string; number?: string }
  | { index: number; ok: false; error: string };

export interface BulkImportResult {
  results: BulkImportRow[];
  succeeded: number;
  failed: number;
  dryRun: boolean;
}

/**
 * Bulk customer import. Two-phase:
 *   1. Validate every row against the refined `customerSchema`. Bad
 *      rows never touch the DB; their error message is captured.
 *   2. (Real run only) persist the validated rows via
 *      `CustomerRepository.bulkCreate` and trigger best-effort AML
 *      screening on each successful insert.
 *
 * `stopOnError:true` short-circuits the validation loop. `dryRun:true`
 * skips phase 2 entirely so an operator can preview validation issues
 * before committing.
 *
 * Results are returned in original CSV order — validation failures are
 * merged back at their original index so the operator can find the
 * offending line without doing arithmetic.
 */
export class BulkImportService {
  constructor(
    private readonly customers: CustomerRepository,
    private readonly screening: ScreeningRepository,
  ) {}

  async run(input: BulkImportInput): Promise<BulkImportResult> {
    const { rows, stopOnError, dryRun } = input;

    const validated = this.validateRows(rows, stopOnError);

    if (dryRun) {
      const results: BulkImportRow[] = validated.map((v) =>
        v.ok
          ? { index: v.index, ok: true }
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

    return this.commit(validated, stopOnError);
  }

  /** Phase 1: per-row zod validation with optional early stop. */
  private validateRows(
    rows: Array<Record<string, unknown>>,
    stopOnError: boolean,
  ) {
    type ValidatedRow =
      | { ok: true; index: number; data: CustomerWriteInput }
      | { ok: false; index: number; error: string };

    const out: ValidatedRow[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = customerSchema.safeParse(rows[i]);
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

  /** Phase 2: persist validated rows and merge results by original index. */
  private async commit(
    validated: Array<
      | { ok: true; index: number; data: CustomerWriteInput }
      | { ok: false; index: number; error: string }
    >,
    stopOnError: boolean,
  ): Promise<BulkImportResult> {
    // Coerce dates and remember which original CSV index each input maps to.
    const validInputs = validated.flatMap((v) =>
      v.ok
        ? [
            {
              input: {
                ...v.data,
                dateOfBirth: new Date(v.data.dateOfBirth),
                hireDate: toDateOrUndefined(v.data.hireDate),
                regularizationDate: toDateOrUndefined(
                  v.data.regularizationDate,
                ),
                spouseDateOfBirth: toDateOrUndefined(v.data.spouseDateOfBirth),
              },
              originalIndex: v.index,
            },
          ]
        : [],
    );

    const createResults = await this.customers.bulkCreate(
      validInputs.map((vi) => vi.input),
      { stopOnError },
    );

    // Best-effort AML screen for each successful creation. Errors are
    // non-fatal — the scheduled job picks up PENDING customers later.
    for (const r of createResults) {
      if (r.ok && r.id) {
        void this.screening.screen(r.id).catch(() => undefined);
      }
    }

    // Merge with validation failures, indexed by the original CSV row.
    const byIndex = new Map<number, BulkImportRow>();
    for (let j = 0; j < createResults.length; j++) {
      const r = createResults[j]!;
      const original = validInputs[j]?.originalIndex ?? r.index;
      if (r.ok && r.id && r.number) {
        byIndex.set(original, {
          index: original,
          ok: true,
          id: r.id,
          number: r.number,
        });
      } else {
        byIndex.set(original, {
          index: original,
          ok: false,
          error: r.error ?? "Create failed",
        });
      }
    }
    for (const v of validated) {
      if (!v.ok)
        byIndex.set(v.index, { index: v.index, ok: false, error: v.error });
    }

    const merged = [...byIndex.values()].sort((a, b) => a.index - b.index);
    const succeeded = merged.filter((r) => r.ok).length;
    return {
      results: merged,
      succeeded,
      failed: merged.length - succeeded,
      dryRun: false,
    };
  }
}
