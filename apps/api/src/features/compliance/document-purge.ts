/**
 * Deleting the uploaded files behind an erased customer.
 *
 * ## The line this module draws
 *
 * A KYC submission is two things wearing one name, and erasure treats
 * them oppositely:
 *
 *   - The **header row** — number, documentType, status, reason,
 *     submittedAt / submittedById, decidedAt / decidedById. This is the
 *     compliance record. It evidences that identity verification
 *     happened, who adjudicated it, and when. AMLA §9 retention applies
 *     to it exactly as it applies to a loan or a journal entry. It
 *     STAYS, untouched, including on erasure.
 *
 *   - The **uploaded file** at `documentUrl` — a photograph of a
 *     person's face, or of their government ID, or their payslip. This
 *     is raw PII and nothing else. Nothing about the verification
 *     decision is recoverable only from the image; the header row
 *     already says what was checked and what was concluded. It GOES.
 *
 * Erasing the header would destroy an AMLA record. Keeping the image
 * would defeat the erasure — a face photograph is the single most
 * identifying artefact the system holds. So the line is drawn between
 * the evidence *that* verification occurred and the raw personal data
 * it was performed on.
 *
 * The same line applies a second time to `LoanApplication`. The
 * face-match outputs (`selfieMatchScore`, `selfieMatchPassed`,
 * `selfieMatchModel`, `selfieMatchedAt`) are the decision record and
 * stay; `applicationSelfieUrl` points at a live-capture photograph of
 * the borrower's face and goes.
 *
 * Co-maker documents are deliberately out of scope: a co-maker is a
 * different data subject, and their erasure is their own request to
 * make.
 *
 * ## The column is only cleared once the bytes are gone
 *
 * Per row the order is: delete the object, THEN clear the column. Never
 * the reverse. If the storage delete fails, the column keeps pointing
 * at the file so the next run retries it — the pointer is the work
 * queue. The consequence is that a cleared column is a true assertion:
 * it means the file is actually gone, not that we meant to remove it.
 *
 * ## Safe to re-run, and safe to preview (§46)
 *
 * Dry run reports the plan and touches nothing. A real run is
 * idempotent: a row whose column is already cleared is not a candidate
 * at all, and a row still pointing at an object that storage says is
 * absent resolves as `ALREADY_ABSENT` — a success, not an error. That
 * covers the backfill case, where the file was removed by hand or by an
 * earlier partial run.
 */

import type { PrismaClient } from "@loan/db";
import type { StorageBackend } from "@loan/storage";

import { keyFromUrl } from "../uploads/backend";

/**
 * What a purged `KycSubmission.documentUrl` holds afterwards.
 *
 * The column is `String` NOT NULL in the schema, so it cannot be
 * nulled the way a nullable PII column can. A sentinel is the same
 * move `eraseCustomer` already makes on `firstName` and `address`, and
 * it is safe by construction: `keyFromUrl` returns null for anything
 * not starting with `/uploads/`, and every caller of `keyFromUrl`
 * treats an unresolvable reference as "no file" (see uploads/backend.ts).
 * So a tombstoned row renders as a missing document rather than a
 * broken fetch.
 *
 * `applicationSelfieUrl` IS nullable and is set to null instead — a
 * truthy sentinel there would make `if (app.applicationSelfieUrl)`
 * render a broken image where "no selfie" is the honest answer.
 */
export const DOCUMENT_TOMBSTONE = "[ERASED]";

/** Per-file result. Only `FAILED` is an error; the rest are successes. */
export type DocumentPurgeOutcome =
  /** The object existed and was removed. */
  | "DELETED"
  /** The row pointed at an object storage no longer has. Nothing to do. */
  | "ALREADY_ABSENT"
  /** The stored value is not a `/uploads/` reference we can key. */
  | "UNRESOLVABLE"
  /** Dry run only — this is what a real run would have removed. */
  | "WOULD_DELETE"
  /** Storage refused the delete. The column is left pointing at it. */
  | "FAILED";

export interface DocumentPurgeItem {
  table: "KycSubmission" | "LoanApplication";
  rowId: string;
  column: "documentUrl" | "applicationSelfieUrl";
  /** Storage key, or null when the stored value did not resolve to one. */
  key: string | null;
  outcome: DocumentPurgeOutcome;
  /** Present only on FAILED. */
  error?: string;
}

export interface DocumentPurgeResult {
  dryRun: boolean;
  /** Candidate rows examined — those still pointing at a file. */
  examined: number;
  counts: {
    deleted: number;
    alreadyAbsent: number;
    unresolvable: number;
    wouldDelete: number;
    failed: number;
  };
  items: DocumentPurgeItem[];
}

interface Candidate {
  table: "KycSubmission" | "LoanApplication";
  rowId: string;
  column: "documentUrl" | "applicationSelfieUrl";
  url: string;
}

/**
 * Rows for this customer that still point at an uploaded file.
 *
 * The tombstone filter is what makes a re-run a no-op rather than a
 * second pass: once a row is purged it stops being a candidate, so the
 * second run examines nothing and reports zero.
 */
async function findCandidates(
  prisma: PrismaClient,
  customerId: string,
): Promise<Candidate[]> {
  const [kyc, apps] = await Promise.all([
    prisma.kycSubmission.findMany({
      where: { customerId, documentUrl: { not: DOCUMENT_TOMBSTONE } },
      select: { id: true, documentUrl: true },
      orderBy: { submittedAt: "asc" },
    }),
    prisma.loanApplication.findMany({
      where: { customerId, applicationSelfieUrl: { not: null } },
      select: { id: true, applicationSelfieUrl: true },
      orderBy: { submittedAt: "asc" },
    }),
  ]);

  const out: Candidate[] = [];
  for (const row of kyc) {
    out.push({
      table: "KycSubmission",
      rowId: row.id,
      column: "documentUrl",
      url: row.documentUrl,
    });
  }
  for (const row of apps) {
    // Narrowed by the query, but TypeScript cannot see that.
    if (!row.applicationSelfieUrl) continue;
    out.push({
      table: "LoanApplication",
      rowId: row.id,
      column: "applicationSelfieUrl",
      url: row.applicationSelfieUrl,
    });
  }
  return out;
}

/**
 * Remove the uploaded files belonging to one customer, keeping every
 * header row.
 *
 * Not gated on `Customer.erasedAt`, deliberately. `eraseCustomer`
 * refuses to run twice — it would lose the original erasure timestamp —
 * but the file purge must stay runnable against an already-erased
 * customer, because that is precisely the population this repairs: the
 * borrowers who were told their documents had been removed by a
 * retention job that never touched storage.
 */
export async function purgeCustomerDocuments(args: {
  prisma: PrismaClient;
  storage: StorageBackend;
  customerId: string;
  dryRun: boolean;
}): Promise<DocumentPurgeResult> {
  const candidates = await findCandidates(args.prisma, args.customerId);
  const items: DocumentPurgeItem[] = [];

  // Rows whose bytes are confirmed gone, grouped so the column clear is
  // one statement per table rather than one per row.
  const clearedKyc: string[] = [];
  const clearedApps: string[] = [];

  for (const c of candidates) {
    const key = keyFromUrl(c.url);
    if (key === null) {
      // Not a stored upload (an external URL, or a shape we refuse to
      // turn into a key). We cannot delete what we cannot address, and
      // guessing would be worse. Reported so it is visible rather than
      // silently counted as done.
      items.push({ ...c, key: null, outcome: "UNRESOLVABLE" });
      continue;
    }

    if (args.dryRun) {
      // Report what a real run would remove, and touch nothing. `exists`
      // is a read, so it is legal here and makes the preview honest
      // about which files are actually still present.
      const present = await args.storage.exists(key);
      items.push({
        ...c,
        key,
        outcome: present ? "WOULD_DELETE" : "ALREADY_ABSENT",
      });
      continue;
    }

    let outcome: DocumentPurgeOutcome;
    let error: string | undefined;
    try {
      // `exists` first only so the report can distinguish "we removed a
      // file" from "there was nothing there". `delete` itself succeeds
      // silently on an absent key, so the race between the two is
      // harmless — the worst case is a DELETED label on an object that
      // vanished microseconds earlier.
      const present = await args.storage.exists(key);
      await args.storage.delete(key);
      outcome = present ? "DELETED" : "ALREADY_ABSENT";
    } catch (err) {
      outcome = "FAILED";
      error = err instanceof Error ? err.message : String(err);
    }

    if (outcome === "FAILED") {
      items.push({ ...c, key, outcome, error });
      continue;
    }

    // Bytes are gone — now, and only now, clear the pointer.
    if (c.table === "KycSubmission") clearedKyc.push(c.rowId);
    else clearedApps.push(c.rowId);
    items.push({ ...c, key, outcome });
  }

  if (!args.dryRun && (clearedKyc.length > 0 || clearedApps.length > 0)) {
    // Header rows are updated, never deleted. `updateMany` on the id
    // set touches exactly the PII pointer column and nothing else — the
    // status, the decision and the timestamps stay as they were.
    await args.prisma.$transaction([
      ...(clearedKyc.length > 0
        ? [
            args.prisma.kycSubmission.updateMany({
              where: { id: { in: clearedKyc } },
              data: { documentUrl: DOCUMENT_TOMBSTONE },
            }),
          ]
        : []),
      ...(clearedApps.length > 0
        ? [
            args.prisma.loanApplication.updateMany({
              where: { id: { in: clearedApps } },
              data: { applicationSelfieUrl: null },
            }),
          ]
        : []),
    ]);
  }

  const counts = {
    deleted: items.filter((i) => i.outcome === "DELETED").length,
    alreadyAbsent: items.filter((i) => i.outcome === "ALREADY_ABSENT").length,
    unresolvable: items.filter((i) => i.outcome === "UNRESOLVABLE").length,
    wouldDelete: items.filter((i) => i.outcome === "WOULD_DELETE").length,
    failed: items.filter((i) => i.outcome === "FAILED").length,
  };

  return { dryRun: args.dryRun, examined: candidates.length, counts, items };
}
