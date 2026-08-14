/**
 * Compliance service — gating tests.
 *
 * Scope is the safety gates that matter for compliance:
 *
 *   1. `eraseCustomer` refuses without `acknowledgesRetention: true`
 *      (auditor-grade double confirmation).
 *   2. `eraseCustomer` refuses to double-erase (would lose the
 *      original erasedAt timestamp).
 *   3. `exportCustomer` writes an audit row for every export — the
 *      DSAR trail itself is auditable.
 *
 * The actual data-walking + redaction logic is exercised end-to-end
 * by the runbook (R7 — see docs/runbooks.md once written). These
 * unit tests just protect the gates.
 */

import { InMemoryStorage } from "@loan/storage";
import { describe, expect, it, vi } from "vitest";

import { ComplianceService } from "./compliance.service";
import { DOCUMENT_TOMBSTONE } from "./document-purge";

/**
 * A KYC row that still points at an uploaded file, plus a loan
 * application carrying a live-capture selfie.
 *
 * These stand in for the two places raw PII images live. The prisma
 * fake below mutates them in place on `updateMany`, so a test can
 * assert the header row survived while its pointer column was cleared —
 * the whole boundary this feature turns on.
 */
interface KycRow {
  id: string;
  documentUrl: string;
  status: string;
  decidedById: string | null;
}
interface AppRow {
  id: string;
  applicationSelfieUrl: string | null;
  selfieMatchPassed: boolean | null;
}

function makePrisma(opts: {
  customer?: { id: string; erasedAt?: Date | null } | null;
  kyc?: KycRow[];
  apps?: AppRow[];
}) {
  const update = vi.fn(async () => ({}));
  const userUpdateMany = vi.fn(async () => ({ count: 0 }));
  const kyc = opts.kyc ?? [];
  const apps = opts.apps ?? [];

  // `findMany` honors the two filters the purge actually sends, so the
  // "already purged rows are not candidates" behaviour is exercised
  // rather than assumed.
  const kycFindMany = vi.fn(
    async (arg?: { where?: { documentUrl?: { not?: string } } }) => {
      const not = arg?.where?.documentUrl?.not;
      return kyc.filter((r) =>
        not === undefined ? true : r.documentUrl !== not,
      );
    },
  );
  const appFindMany = vi.fn(
    async (arg?: { where?: { applicationSelfieUrl?: { not?: null } } }) => {
      const wantsNotNull = arg?.where?.applicationSelfieUrl !== undefined;
      return apps.filter((r) =>
        wantsNotNull ? r.applicationSelfieUrl !== null : true,
      );
    },
  );
  const kycUpdateMany = vi.fn(
    async (arg: {
      where: { id: { in: string[] } };
      data: { documentUrl: string };
    }) => {
      let count = 0;
      for (const row of kyc) {
        if (arg.where.id.in.includes(row.id)) {
          row.documentUrl = arg.data.documentUrl;
          count += 1;
        }
      }
      return { count };
    },
  );
  const appUpdateMany = vi.fn(
    async (arg: {
      where: { id: { in: string[] } };
      data: { applicationSelfieUrl: null };
    }) => {
      let count = 0;
      for (const row of apps) {
        if (arg.where.id.in.includes(row.id)) {
          row.applicationSelfieUrl = arg.data.applicationSelfieUrl;
          count += 1;
        }
      }
      return { count };
    },
  );

  return {
    customer: {
      findUnique: vi.fn(async () => opts.customer ?? null),
      update,
    },
    user: { updateMany: userUpdateMany },
    // Every relation read returns [] (or the seeded rows) so the export
    // test runs against an "empty-but-existing" customer. We're not
    // testing what's returned; we're testing that the gate before the
    // read held.
    kycSubmission: { findMany: kycFindMany, updateMany: kycUpdateMany },
    loanApplication: { findMany: appFindMany, updateMany: appUpdateMany },
    loanSchedule: { findMany: vi.fn(async () => []) },
    loanPayment: { findMany: vi.fn(async () => []) },
    auditEvent: { findMany: vi.fn(async () => []) },
    contribution: { findMany: vi.fn(async () => []) },
    savingsTransaction: { findMany: vi.fn(async () => []) },
    amlScreening: { findMany: vi.fn(async () => []) },
    surveyResponse: { findMany: vi.fn(async () => []) },
    creditScore: { findMany: vi.fn(async () => []) },
    notification: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (ops: unknown[]) => {
      // Execute each op — they're already promises in Prisma's
      // sequential transaction form.
      const results = [];
      for (const op of ops) results.push(await op);
      return results;
    }),
    _customerUpdate: update,
    _userUpdateMany: userUpdateMany,
    _kyc: kyc,
    _apps: apps,
  };
}

/** A storage backend preloaded with the objects the seeded rows name. */
async function makeStorage(keys: string[]): Promise<InMemoryStorage> {
  const storage = new InMemoryStorage();
  for (const key of keys) {
    // Content is irrelevant; presence is the whole point.
    await storage.put(key, Buffer.from("fake-image-bytes"));
  }
  return storage;
}

type AuditCall = {
  action: string;
  actorId: string;
  targetType?: string;
  targetId?: string;
  payload?: unknown;
};

function makeAudit() {
  return {
    record: vi.fn(async (_input: AuditCall) => ({ id: "audit-1" })),
  };
}

const CUSTOMER_ID = "11111111-2222-3333-4444-555555555555";
const ACTOR_ID = "actor-1";

describe("ComplianceService", () => {
  describe("eraseCustomer — gates", () => {
    it("refuses without acknowledgesRetention", async () => {
      const prisma = makePrisma({ customer: { id: CUSTOMER_ID } });
      const audit = makeAudit();
      const svc = new ComplianceService(
        prisma as never,
        audit as never,
        new InMemoryStorage(),
      );

      const result = await svc.eraseCustomer({
        customerId: CUSTOMER_ID,
        actorId: ACTOR_ID,
        reason: "DSAR ticket #1234",
        acknowledgesRetention: false,
      });
      expect(result.ok).toBe(false);
      expect((result as { kind: string }).kind).toBe("AcknowledgmentRequired");
      // Critical: nothing was written. The transaction never ran.
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it("returns NotFound on a missing customer", async () => {
      const prisma = makePrisma({ customer: null });
      const audit = makeAudit();
      const svc = new ComplianceService(
        prisma as never,
        audit as never,
        new InMemoryStorage(),
      );

      const result = await svc.eraseCustomer({
        customerId: CUSTOMER_ID,
        actorId: ACTOR_ID,
        reason: "DSAR ticket #1234",
        acknowledgesRetention: true,
      });
      expect(result.ok).toBe(false);
      expect((result as { kind: string }).kind).toBe("NotFound");
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("refuses to double-erase", async () => {
      const prisma = makePrisma({
        customer: { id: CUSTOMER_ID, erasedAt: new Date("2026-01-01") },
      });
      const audit = makeAudit();
      const svc = new ComplianceService(
        prisma as never,
        audit as never,
        new InMemoryStorage(),
      );

      const result = await svc.eraseCustomer({
        customerId: CUSTOMER_ID,
        actorId: ACTOR_ID,
        reason: "duplicate request",
        acknowledgesRetention: true,
      });
      expect(result.ok).toBe(false);
      expect((result as { kind: string }).kind).toBe("AlreadyErased");
      // Critical: the original erasedAt isn't overwritten.
      expect(prisma._customerUpdate).not.toHaveBeenCalled();
    });

    it("erases when gates pass and records the audit row", async () => {
      const prisma = makePrisma({
        customer: { id: CUSTOMER_ID, erasedAt: null },
      });
      const audit = makeAudit();
      const svc = new ComplianceService(
        prisma as never,
        audit as never,
        new InMemoryStorage(),
      );

      const result = await svc.eraseCustomer({
        customerId: CUSTOMER_ID,
        actorId: ACTOR_ID,
        reason: "DSAR ticket #1234 — borrower closed account",
        acknowledgesRetention: true,
      });
      expect(result.ok).toBe(true);
      // Update transaction + portal-login deactivation both fired.
      expect(prisma._customerUpdate).toHaveBeenCalledTimes(1);
      expect(prisma._userUpdateMany).toHaveBeenCalledTimes(1);
      // Audit row carries the reason + cleared fields.
      expect(audit.record).toHaveBeenCalledTimes(1);
      const call = audit.record.mock.calls[0]![0] as unknown as {
        action: string;
        payload: { reason: string; fieldsCleared: string[] };
      };
      expect(call.action).toBe("CUSTOMER_ERASE");
      expect(call.payload.reason).toBe(
        "DSAR ticket #1234 — borrower closed account",
      );
      expect(call.payload.fieldsCleared).toContain("firstName");
      expect(call.payload.fieldsCleared).toContain("governmentIdNumber");
    });
  });

  describe("exportCustomer — audit", () => {
    it("returns NotFound on a missing customer (no audit row)", async () => {
      const prisma = makePrisma({ customer: null });
      const audit = makeAudit();
      const svc = new ComplianceService(
        prisma as never,
        audit as never,
        new InMemoryStorage(),
      );

      const result = await svc.exportCustomer({
        customerId: CUSTOMER_ID,
        actorId: ACTOR_ID,
      });
      expect(result.ok).toBe(false);
      // Not-found exports are NOT logged — they're a permission-
      // check failure shape, not a privacy-relevant action.
      expect(audit.record).not.toHaveBeenCalled();
    });

    it("writes an audit row for every successful export", async () => {
      const prisma = makePrisma({ customer: { id: CUSTOMER_ID } });
      const audit = makeAudit();
      const svc = new ComplianceService(
        prisma as never,
        audit as never,
        new InMemoryStorage(),
      );

      const result = await svc.exportCustomer({
        customerId: CUSTOMER_ID,
        actorId: ACTOR_ID,
        reason: "DSAR ticket #5678",
      });
      expect(result.ok).toBe(true);
      expect(audit.record).toHaveBeenCalledTimes(1);
      const call = audit.record.mock.calls[0]![0] as unknown as {
        action: string;
        payload: { reason: string | null; rowCounts: object };
      };
      expect(call.action).toBe("CUSTOMER_DATA_EXPORT");
      expect(call.payload.reason).toBe("DSAR ticket #5678");
      // rowCounts captures the size of each section — useful for
      // compliance to verify the export matched what was sent.
      expect(call.payload.rowCounts).toMatchObject({
        kycSubmissions: 0,
        loanApplications: 0,
        auditEvents: 0,
      });
    });

    it("audits with reason=null when none is supplied", async () => {
      const prisma = makePrisma({ customer: { id: CUSTOMER_ID } });
      const audit = makeAudit();
      const svc = new ComplianceService(
        prisma as never,
        audit as never,
        new InMemoryStorage(),
      );

      await svc.exportCustomer({
        customerId: CUSTOMER_ID,
        actorId: ACTOR_ID,
      });
      const call = audit.record.mock.calls[0]![0] as unknown as {
        payload: { reason: string | null };
      };
      expect(call.payload.reason).toBeNull();
    });
  });

  /**
   * The defect these cover: the erasure response told a data subject
   * that their uploaded ID photos, payslips and selfies were "cleared
   * separately by retention job". `RetentionService.runPurge` deletes
   * audit, notification and job-run rows and touches storage nowhere.
   * The files persisted indefinitely.
   *
   * The line under test is the one that makes this safe to fix: the
   * KycSubmission HEADER is an AMLA §9 compliance record and must
   * survive erasure; the FILE behind it is raw PII and must not.
   */
  describe("document purge — the header/file boundary", () => {
    const KYC_URL = "/uploads/kyc/id-front.jpg";
    const KYC_KEY = "kyc/id-front.jpg";
    const SELFIE_URL = "/uploads/kyc/selfie.jpg";
    const SELFIE_KEY = "kyc/selfie.jpg";

    function seed() {
      return {
        kyc: [
          {
            id: "kyc-1",
            documentUrl: KYC_URL,
            status: "VERIFIED",
            decidedById: "officer-9",
          },
        ],
        apps: [
          {
            id: "app-1",
            applicationSelfieUrl: SELFIE_URL,
            selfieMatchPassed: true,
          },
        ],
      };
    }

    it("erasure deletes the uploaded file and KEEPS the header row", async () => {
      const seeded = seed();
      const prisma = makePrisma({
        customer: { id: CUSTOMER_ID, erasedAt: null },
        ...seeded,
      });
      const storage = await makeStorage([KYC_KEY, SELFIE_KEY]);
      const svc = new ComplianceService(
        prisma as never,
        makeAudit() as never,
        storage,
      );

      const result = await svc.eraseCustomer({
        customerId: CUSTOMER_ID,
        actorId: ACTOR_ID,
        reason: "DSAR ticket #1234 — borrower closed account",
        acknowledgesRetention: true,
      });

      expect(result.ok).toBe(true);
      // The bytes are gone. This is the half that did not exist before.
      expect(storage.keys()).toEqual([]);

      // The header row is STILL THERE, and still says what was decided
      // and by whom. Erasing it would have destroyed an AMLA record.
      expect(prisma._kyc).toHaveLength(1);
      expect(prisma._kyc[0]!.status).toBe("VERIFIED");
      expect(prisma._kyc[0]!.decidedById).toBe("officer-9");
      // Only the pointer to the image was cleared.
      expect(prisma._kyc[0]!.documentUrl).toBe(DOCUMENT_TOMBSTONE);

      // Same boundary on the loan application: the face-match OUTPUT is
      // the decision record and survives; the photograph does not.
      expect(prisma._apps[0]!.selfieMatchPassed).toBe(true);
      expect(prisma._apps[0]!.applicationSelfieUrl).toBeNull();

      const purged = (
        result as { documentsPurged: { counts: { deleted: number } } }
      ).documentsPurged;
      expect(purged.counts.deleted).toBe(2);
    });

    it("the erasure response reports the purge instead of promising it", async () => {
      const prisma = makePrisma({
        customer: { id: CUSTOMER_ID, erasedAt: null },
        ...seed(),
      });
      const svc = new ComplianceService(
        prisma as never,
        makeAudit() as never,
        await makeStorage([KYC_KEY, SELFIE_KEY]),
      );

      const result = (await svc.eraseCustomer({
        customerId: CUSTOMER_ID,
        actorId: ACTOR_ID,
        reason: "DSAR ticket #1234",
        acknowledgesRetention: true,
      })) as { retainedTables: string[] };

      const kycLine = result.retainedTables.find((t) =>
        t.startsWith("KycSubmission"),
      );
      // The old wording pointed at a retention job that never touched
      // storage. Nothing in the response may promise future work.
      expect(kycLine).toBeDefined();
      expect(kycLine).not.toMatch(/retention job/i);
      expect(kycLine).not.toMatch(/separately/i);
      expect(kycLine).toMatch(/header rows only/i);
    });

    it("dry run reports the plan and deletes nothing", async () => {
      const prisma = makePrisma({
        customer: { id: CUSTOMER_ID, erasedAt: null },
        ...seed(),
      });
      const storage = await makeStorage([KYC_KEY, SELFIE_KEY]);
      const svc = new ComplianceService(
        prisma as never,
        makeAudit() as never,
        storage,
      );

      const result = (await svc.purgeDocuments({
        customerId: CUSTOMER_ID,
        actorId: ACTOR_ID,
        reason: "pre-erasure validation",
        dryRun: true,
      })) as {
        counts: { wouldDelete: number; deleted: number };
        examined: number;
      };

      expect(result.examined).toBe(2);
      expect(result.counts.wouldDelete).toBe(2);
      expect(result.counts.deleted).toBe(0);
      // Nothing moved: objects still present, columns untouched.
      expect(storage.keys()).toEqual([KYC_KEY, SELFIE_KEY].sort());
      expect(prisma._kyc[0]!.documentUrl).toBe(KYC_URL);
      expect(prisma._apps[0]!.applicationSelfieUrl).toBe(SELFIE_URL);
      expect(prisma.kycSubmission.updateMany).not.toHaveBeenCalled();
      expect(prisma.loanApplication.updateMany).not.toHaveBeenCalled();
    });

    it("re-running after a purge is a no-op, not an error", async () => {
      const prisma = makePrisma({
        customer: { id: CUSTOMER_ID, erasedAt: null },
        ...seed(),
      });
      const storage = await makeStorage([KYC_KEY, SELFIE_KEY]);
      const svc = new ComplianceService(
        prisma as never,
        makeAudit() as never,
        storage,
      );

      const first = (await svc.purgeDocuments({
        customerId: CUSTOMER_ID,
        actorId: ACTOR_ID,
        reason: "erasure follow-up",
        dryRun: false,
      })) as { counts: { deleted: number } };
      expect(first.counts.deleted).toBe(2);

      const second = (await svc.purgeDocuments({
        customerId: CUSTOMER_ID,
        actorId: ACTOR_ID,
        reason: "erasure follow-up (retry)",
        dryRun: false,
      })) as {
        ok: boolean;
        examined: number;
        counts: { deleted: number; failed: number };
      };

      // A purged row stops being a candidate, so the second run has
      // nothing to examine. Success, not a failure.
      expect(second.ok).toBe(true);
      expect(second.examined).toBe(0);
      expect(second.counts.deleted).toBe(0);
      expect(second.counts.failed).toBe(0);
    });

    it("a file already gone from storage resolves ALREADY_ABSENT, not an error", async () => {
      const prisma = makePrisma({
        customer: { id: CUSTOMER_ID, erasedAt: null },
        kyc: [
          {
            id: "kyc-1",
            documentUrl: KYC_URL,
            status: "VERIFIED",
            decidedById: "officer-9",
          },
        ],
      });
      // Storage is empty — the row points at an object that is not there,
      // which is exactly the state a half-finished earlier run leaves.
      const svc = new ComplianceService(
        prisma as never,
        makeAudit() as never,
        await makeStorage([]),
      );

      const result = (await svc.purgeDocuments({
        customerId: CUSTOMER_ID,
        actorId: ACTOR_ID,
        reason: "backfill for a pre-fix erasure",
        dryRun: false,
      })) as {
        ok: boolean;
        counts: { alreadyAbsent: number; failed: number };
      };

      expect(result.ok).toBe(true);
      expect(result.counts.alreadyAbsent).toBe(1);
      expect(result.counts.failed).toBe(0);
      // Still tombstoned — the file is gone, which is what the column
      // now asserts.
      expect(prisma._kyc[0]!.documentUrl).toBe(DOCUMENT_TOMBSTONE);
    });

    it("leaves a non-uploads reference alone rather than guessing", async () => {
      const prisma = makePrisma({
        customer: { id: CUSTOMER_ID, erasedAt: null },
        kyc: [
          {
            id: "kyc-1",
            documentUrl: "https://legacy.example.com/scan.jpg",
            status: "VERIFIED",
            decidedById: "officer-9",
          },
        ],
      });
      const svc = new ComplianceService(
        prisma as never,
        makeAudit() as never,
        await makeStorage([]),
      );

      const result = (await svc.purgeDocuments({
        customerId: CUSTOMER_ID,
        actorId: ACTOR_ID,
        reason: "backfill sweep",
        dryRun: false,
      })) as { counts: { unresolvable: number } };

      expect(result.counts.unresolvable).toBe(1);
      // Not tombstoned: claiming the file is gone would be the same
      // false statement this whole change exists to remove.
      expect(prisma._kyc[0]!.documentUrl).toBe(
        "https://legacy.example.com/scan.jpg",
      );
    });

    it("is runnable on an already-erased customer (the repair path)", async () => {
      const prisma = makePrisma({
        // erasedAt set: eraseCustomer would refuse with AlreadyErased.
        customer: { id: CUSTOMER_ID, erasedAt: new Date("2026-01-01") },
        ...seed(),
      });
      const storage = await makeStorage([KYC_KEY, SELFIE_KEY]);
      const svc = new ComplianceService(
        prisma as never,
        makeAudit() as never,
        storage,
      );

      const result = (await svc.purgeDocuments({
        customerId: CUSTOMER_ID,
        actorId: ACTOR_ID,
        reason: "repair: erased before the file purge existed",
        dryRun: false,
      })) as { ok: boolean; counts: { deleted: number } };

      expect(result.ok).toBe(true);
      expect(result.counts.deleted).toBe(2);
      expect(storage.keys()).toEqual([]);
    });
  });
});
