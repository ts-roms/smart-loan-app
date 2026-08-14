import type { LoanApplication, PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { LoanRepository } from "./loan.repository";

/**
 * GOLDEN TESTS — what every write path does to `LoanSchedule`.
 *
 * Written to settle the gap-matrix row "Immutable schedule versions", which
 * has sat at NEEDS VERIFICATION since the Phase 0 audit on the claim that
 * "schedule rows mutate on restructure". These pin the CURRENT behaviour of
 * every path that writes the table, and they are committed passing against
 * unmodified code, per §81.
 *
 * The distinction the whole row turns on, and the line these tests draw:
 *
 *   CONTRACTUAL columns — `installmentNo`, `dueDate`, `principalDue`,
 *   `interestDue`, `totalDue` — are the borrower's promise: what is owed,
 *   and when. Changing one after the fact rewrites the contract, and that
 *   is what §12 forbids.
 *
 *   SERVICING columns — `principalPaid`, `interestPaid`, `paidInFullAt` —
 *   are how far through that promise the borrower has got. They are
 *   SUPPOSED to move as payments land. A rising `principalPaid` is the row
 *   doing its job, not a history rewrite.
 *
 * What the current implementation actually does:
 *
 *   `disburse` is the ONLY writer of contractual columns, via one
 *   `createMany` that mints the whole schedule at disbursement. It is
 *   preceded by an atomic status claim (APPROVED -> DISBURSED), so it
 *   cannot run twice, and the insert sets no servicing column — those take
 *   their schema defaults of 0 / 0 / null.
 *
 *   Every OTHER write in the repository — the renewal settlement inside
 *   `disburse`, `recordPayment`, `closeEarly`, `restructure`, `writeOff`,
 *   and `RepossessionRepository.auction` — is an `update` whose `data`
 *   contains servicing columns and nothing else.
 *
 *   `restructure` in particular does NOT re-cut the original schedule. It
 *   settles the original's open instalments and mints a wholly NEW
 *   `LoanApplication` (linked by `restructuredFromId`) which grows its own
 *   schedule at ITS disbursement. The new terms never overwrite the old.
 *
 * The one lossy thing, pinned in the last describe block: the four
 * force-settlement paths write `principalPaid := principalDue` and
 * `interestPaid := interestDue`, overwriting what the borrower had really
 * paid on a part-paid instalment. That is a servicing-column overwrite, not
 * a contract rewrite, and `LoanPayment` is append-only so the true figure
 * is recomputable — but it is not recoverable from the schedule row itself.
 */

// ─── The two column sets the row turns on ──────────────────────────────

const CONTRACTUAL = [
  "installmentNo",
  "dueDate",
  "principalDue",
  "interestDue",
  "totalDue",
] as const;

const SERVICING = ["principalPaid", "interestPaid", "paidInFullAt"] as const;

// ─── Harness ───────────────────────────────────────────────────────────

interface Row {
  id: string;
  loanId: string;
  installmentNo: number;
  dueDate: Date;
  principalDue: number;
  interestDue: number;
  totalDue: number;
  principalPaid: number;
  interestPaid: number;
  paidInFullAt: Date | null;
}

/** One recorded write against `LoanSchedule`. */
interface ScheduleWrite {
  op: "createMany" | "update";
  /** The row targeted by an `update`; null for an insert. */
  rowId: string | null;
  data: Record<string, unknown>;
}

const PRODUCT = {
  id: "p1",
  code: "SALARY",
  name: "Salary Loan",
  interestMethod: "DECLINING",
  paymentFrequency: "MONTHLY",
  processingFeeRate: 0.01,
  processingFeeFlat: 0,
  documentaryStampRate: 0,
  preTerminationFeeRate: 0.02,
  isLease: false,
  residualValueFraction: null,
};

/**
 * Three instalments of 1,000 principal + 100 interest. Instalment 1 is
 * genuinely part-paid — interest cleared and 400 of the 1,000 principal,
 * which is what interest-then-principal allocation produces — so the
 * settlement paths have a real figure to overwrite.
 */
function seedRows(): Row[] {
  return [
    {
      id: "s1",
      loanId: "L1",
      installmentNo: 1,
      dueDate: new Date("2026-01-15T00:00:00.000Z"),
      principalDue: 1000,
      interestDue: 100,
      totalDue: 1100,
      principalPaid: 400,
      interestPaid: 100,
      paidInFullAt: null,
    },
    {
      id: "s2",
      loanId: "L1",
      installmentNo: 2,
      dueDate: new Date("2026-02-15T00:00:00.000Z"),
      principalDue: 1000,
      interestDue: 100,
      totalDue: 1100,
      principalPaid: 0,
      interestPaid: 0,
      paidInFullAt: null,
    },
    {
      id: "s3",
      loanId: "L1",
      installmentNo: 3,
      dueDate: new Date("2026-03-15T00:00:00.000Z"),
      principalDue: 1000,
      interestDue: 100,
      totalDue: 1100,
      principalPaid: 0,
      interestPaid: 0,
      paidInFullAt: null,
    },
  ];
}

interface HarnessOptions {
  status?: string;
  rows?: Row[];
  principal?: number;
  termMonths?: number;
}

/**
 * A fake Prisma that records every `LoanSchedule` write and applies it to an
 * in-memory row store, so a test can assert both WHAT was sent and what the
 * rows look like afterwards. Only the models these paths actually touch are
 * modelled; anything else would throw, which is the desired failure mode.
 */
function harness(opts: HarnessOptions = {}) {
  const state = {
    status: opts.status ?? "ACTIVE",
    rows: opts.rows ?? seedRows(),
    writes: [] as ScheduleWrite[],
    payments: [] as Record<string, unknown>[],
    replacementsCreated: 0,
  };

  const loan = () => ({
    id: "L1",
    number: "LN-1",
    status: state.status,
    customerId: "c1",
    principal: opts.principal ?? 3000,
    termMonths: opts.termMonths ?? 3,
    annualInterestRate: 0.12,
    restructuredFromId: null,
    renewedFromId: null,
    agentId: null,
    agentCommissionPostedAt: null,
    agentCommissionAmount: 0,
    creditScoreAtApply: 700,
    tierAtApply: "B",
    product: PRODUCT,
    customer: { id: "c1" },
  });

  /** Honour a Prisma status filter against LIVE state, as the claim does. */
  const statusMatches = (want: unknown): boolean => {
    if (want === undefined) return true;
    if (typeof want === "string") return want === state.status;
    const w = want as { in?: string[]; notIn?: string[] };
    if (w.in) return w.in.includes(state.status);
    if (w.notIn) return !w.notIn.includes(state.status);
    return true;
  };

  const client = {
    $transaction: <T>(fn: (tx: unknown) => Promise<T>) => fn(client),

    loanApplication: {
      findFirst: (args: { include?: { schedule?: unknown } } = {}) => {
        const base = loan();
        if (!args.include?.schedule) return Promise.resolve(base);
        // Every caller that includes the schedule filters it to open rows.
        const open = state.rows
          .filter((r) => r.paidInFullAt === null)
          .map((r) => ({ ...r }));
        return Promise.resolve({ ...base, schedule: open });
      },
      updateMany: ({
        where,
        data,
      }: {
        where: { id: string; status?: unknown };
        data: { status?: string };
      }) => {
        if (where.id !== "L1" || !statusMatches(where.status)) {
          return Promise.resolve({ count: 0 });
        }
        if (data.status) state.status = data.status;
        return Promise.resolve({ count: 1 });
      },
      findUnique: () => Promise.resolve({ status: state.status }),
      findUniqueOrThrow: () => Promise.resolve(loan()),
      update: ({ data }: { data: { status?: string } }) => {
        if (data.status) state.status = data.status;
        return Promise.resolve(loan());
      },
    },

    loanSchedule: {
      createMany: ({ data }: { data: Record<string, unknown>[] }) => {
        for (const d of data) {
          state.writes.push({ op: "createMany", rowId: null, data: d });
          state.rows.push({
            ...d,
            id: `new-${String(d["installmentNo"])}`,
            // Schema defaults: the insert sets none of these.
            principalPaid: 0,
            interestPaid: 0,
            paidInFullAt: null,
          } as unknown as Row);
        }
        return Promise.resolve({ count: data.length });
      },
      update: ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        state.writes.push({ op: "update", rowId: where.id, data });
        const row = state.rows.find((r) => r.id === where.id);
        if (row) Object.assign(row, data);
        return Promise.resolve({ ...row });
      },
      findMany: ({ where }: { where?: { paidInFullAt?: null } } = {}) => {
        const rows =
          where?.paidInFullAt === null
            ? state.rows.filter((r) => r.paidInFullAt === null)
            : state.rows;
        return Promise.resolve(
          [...rows]
            .sort((a, b) => a.installmentNo - b.installmentNo)
            .map((r) => ({ ...r })),
        );
      },
      count: ({ where }: { where?: { paidInFullAt?: null } } = {}) =>
        Promise.resolve(
          where?.paidInFullAt === null
            ? state.rows.filter((r) => r.paidInFullAt === null).length
            : state.rows.length,
        ),
    },

    loanPayment: {
      create: ({ data }: { data: Record<string, unknown> }) => {
        state.payments.push(data);
        return Promise.resolve({ id: `pay-${state.payments.length}`, ...data });
      },
      findUnique: () => Promise.resolve(null),
    },

    customer: {
      findUnique: () => Promise.resolve({ employmentStatus: "SELF_EMPLOYED" }),
    },
    agent: { findUnique: () => Promise.resolve({ number: "AG-1" }) },
    leaseAgreement: { upsert: () => Promise.resolve({}) },
  };

  const repo = new LoanRepository(client as unknown as PrismaClient);
  (repo as unknown as { accounting: unknown }).accounting = {
    postIfAbsent: () => Promise.resolve(null),
  };
  // `restructure` delegates replacement-loan creation to `applyInTx`; stub it
  // so the test observes the schedule writes rather than loan-numbering.
  (repo as unknown as { applyInTx: () => Promise<LoanApplication> }).applyInTx =
    () => {
      state.replacementsCreated += 1;
      return Promise.resolve({
        id: "L2",
        number: "LN-2",
      } as LoanApplication);
    };

  return { repo, state };
}

/** Columns touched by writes against already-existing rows. */
function updatedColumns(writes: ScheduleWrite[]): string[] {
  return [
    ...new Set(
      writes
        .filter((w) => w.op === "update")
        .flatMap((w) => Object.keys(w.data)),
    ),
  ].sort();
}

const CLOSE_INPUT = { closedById: "officer-1", settlementAmount: 3000 };
const RESTRUCTURE_INPUT = {
  restructuredById: "officer-1",
  productCode: "SALARY",
  principal: 4000,
  termMonths: 12,
  annualInterestRate: 0.18,
};
const WRITE_OFF_INPUT = {
  writtenOffById: "officer-1",
  reason: "uncollectable",
};

// ─── disburse: the sole writer of contractual columns ───────────────────

describe("GOLDEN — disburse mints the schedule and never sets a paid column", () => {
  it("inserts one row per instalment via a single createMany", async () => {
    const { repo, state } = harness({ status: "APPROVED", rows: [] });

    await repo.disburse("LN-1", { disbursedById: "officer-1" });

    const inserts = state.writes.filter((w) => w.op === "createMany");
    expect(inserts).toHaveLength(3);
    expect(inserts.map((w) => w.data["installmentNo"])).toEqual([1, 2, 3]);
    // One insert, no follow-up correction of any row.
    expect(state.writes.filter((w) => w.op === "update")).toHaveLength(0);
  });

  it("writes exactly loanId plus the five contractual columns, and no servicing column", async () => {
    const { repo, state } = harness({ status: "APPROVED", rows: [] });

    await repo.disburse("LN-1", { disbursedById: "officer-1" });

    for (const insert of state.writes.filter((w) => w.op === "createMany")) {
      expect(Object.keys(insert.data).sort()).toEqual(
        ["loanId", ...CONTRACTUAL].sort(),
      );
      for (const column of SERVICING) {
        expect(insert.data).not.toHaveProperty(column);
      }
    }
  });

  it("dates the instalments from the disbursement, strictly increasing", async () => {
    const startedAt = new Date();
    const { repo, state } = harness({ status: "APPROVED", rows: [] });

    await repo.disburse("LN-1", { disbursedById: "officer-1" });

    const dueDates = state.writes
      .filter((w) => w.op === "createMany")
      .map((w) => w.data["dueDate"] as Date);
    // The schedule's clock starts at disbursement, not at application.
    expect(dueDates[0]!.getTime()).toBeGreaterThan(startedAt.getTime());
    expect(dueDates[1]!.getTime()).toBeGreaterThan(dueDates[0]!.getTime());
    expect(dueDates[2]!.getTime()).toBeGreaterThan(dueDates[1]!.getTime());
  });

  it("refuses a second disbursement, so a loan can never grow a second schedule", async () => {
    const { repo, state } = harness({ status: "APPROVED", rows: [] });

    await repo.disburse("LN-1", { disbursedById: "officer-1" });
    // The claim moved the loan off APPROVED; the schedule insert is behind it.
    await expect(
      repo.disburse("LN-1", { disbursedById: "officer-1" }),
    ).rejects.toThrow(/Cannot disburse from status/);

    expect(state.writes.filter((w) => w.op === "createMany")).toHaveLength(3);
  });
});

// ─── restructure: the row's original accusation ────────────────────────

describe("GOLDEN — restructure does not re-cut the original schedule", () => {
  it("issues no INSERT against the original loan's schedule", async () => {
    const { repo, state } = harness();

    await repo.restructure("LN-1", RESTRUCTURE_INPUT);

    // The new terms live on a NEW loan, which grows its own schedule at its
    // own disbursement. Nothing is added to, or re-cut on, the original.
    expect(state.writes.filter((w) => w.op === "createMany")).toHaveLength(0);
    expect(state.replacementsCreated).toBe(1);
  });

  it("updates only servicing columns on the original's open instalments", async () => {
    const { repo, state } = harness();

    await repo.restructure("LN-1", RESTRUCTURE_INPUT);

    expect(updatedColumns(state.writes)).toEqual([...SERVICING].sort());
  });

  it("leaves every contractual value on every row exactly as it was", async () => {
    const before = seedRows();
    const { repo, state } = harness({ rows: seedRows() });

    await repo.restructure("LN-1", RESTRUCTURE_INPUT);

    for (const original of before) {
      const after = state.rows.find((r) => r.id === original.id)!;
      for (const column of CONTRACTUAL) {
        expect(after[column]).toEqual(original[column]);
      }
    }
  });

  it("settles all three open instalments and closes the original", async () => {
    const { repo, state } = harness();

    const result = await repo.restructure("LN-1", RESTRUCTURE_INPUT);

    expect(state.writes.filter((w) => w.op === "update")).toHaveLength(3);
    expect(state.rows.every((r) => r.paidInFullAt !== null)).toBe(true);
    expect(result.original.status).toBe("RESTRUCTURED");
    expect(result.replacement.number).toBe("LN-2");
  });
});

// ─── every other settlement path, same shape ───────────────────────────

describe("GOLDEN — the settlement paths touch servicing columns only", () => {
  const paths: Array<[string, (repo: LoanRepository) => Promise<unknown>]> = [
    ["closeEarly", (repo) => repo.closeEarly("LN-1", CLOSE_INPUT)],
    ["writeOff", (repo) => repo.writeOff("LN-1", WRITE_OFF_INPUT)],
    ["restructure", (repo) => repo.restructure("LN-1", RESTRUCTURE_INPUT)],
  ];

  for (const [name, run] of paths) {
    it(`${name} writes exactly {paidInFullAt, principalPaid, interestPaid}`, async () => {
      const { repo, state } = harness();

      await run(repo);

      const updates = state.writes.filter((w) => w.op === "update");
      expect(updates.length).toBeGreaterThan(0);
      for (const write of updates) {
        expect(Object.keys(write.data).sort()).toEqual([...SERVICING].sort());
      }
    });

    it(`${name} changes no contractual column`, async () => {
      const before = seedRows();
      const { repo, state } = harness({ rows: seedRows() });

      await run(repo);

      for (const original of before) {
        const after = state.rows.find((r) => r.id === original.id)!;
        for (const column of CONTRACTUAL) {
          expect(after[column]).toEqual(original[column]);
        }
      }
    });
  }

  it("recordPayment moves the paid columns and nothing else", async () => {
    const { repo, state } = harness();

    await repo.recordPayment("LN-1", {
      amount: 600,
      paidOn: new Date("2026-01-20T00:00:00.000Z"),
      recordedById: "teller-1",
    });

    expect(updatedColumns(state.writes)).toEqual([...SERVICING].sort());
    // Instalment 1 had 400 of 1,000 principal paid and its interest cleared;
    // 600 more settles it exactly.
    const s1 = state.rows.find((r) => r.id === "s1")!;
    expect(s1.principalPaid).toBe(1000);
    expect(s1.interestPaid).toBe(100);
    expect(s1.paidInFullAt).not.toBeNull();
    // ...and the contract it was measured against is untouched.
    expect(s1.principalDue).toBe(1000);
    expect(s1.totalDue).toBe(1100);
  });
});

// ─── the one thing that IS overwritten ─────────────────────────────────

describe("GOLDEN — force-settlement overwrites real payment progress", () => {
  /*
   * This is the honest caveat behind the verdict on the row. A settlement
   * writes `principalPaid := principalDue`, so a part-paid instalment loses
   * the record of what was really paid on it. The borrower did not pay
   * 1,000 on instalment 1 — they paid 400.
   *
   * It is a servicing column, not a contractual one, and `LoanPayment` is
   * append-only so the true figure is recomputable by replay. But it is not
   * readable from the schedule row afterwards, and
   * `repair-payment-allocations.ts` deliberately REFUSES to replay a
   * force-settled loan, so nothing in the system reconstructs it today.
   */
  for (const [name, run] of [
    [
      "closeEarly",
      (repo: LoanRepository) => repo.closeEarly("LN-1", CLOSE_INPUT),
    ],
    [
      "writeOff",
      (repo: LoanRepository) => repo.writeOff("LN-1", WRITE_OFF_INPUT),
    ],
    [
      "restructure",
      (repo: LoanRepository) => repo.restructure("LN-1", RESTRUCTURE_INPUT),
    ],
  ] as Array<[string, (repo: LoanRepository) => Promise<unknown>]>) {
    it(`${name} raises a part-paid instalment's principalPaid to principalDue`, async () => {
      const { repo, state } = harness();
      expect(state.rows.find((r) => r.id === "s1")!.principalPaid).toBe(400);

      await run(repo);

      const s1 = state.rows.find((r) => r.id === "s1")!;
      expect(s1.principalPaid).toBe(1000);
      expect(s1.interestPaid).toBe(100);
      // The 400 is gone from this row; no column on LoanSchedule retains it.
      expect(Object.values(s1)).not.toContain(400);
    });
  }

  it("records no snapshot of the pre-settlement state on the row", async () => {
    const { repo, state } = harness();

    await repo.restructure("LN-1", RESTRUCTURE_INPUT);

    // Every write is a plain overwrite — nothing copies the old value aside.
    for (const write of state.writes) {
      expect(Object.keys(write.data)).not.toContain("previousPrincipalPaid");
      expect(Object.keys(write.data)).not.toContain("version");
      expect(Object.keys(write.data)).not.toContain("supersededAt");
    }
  });
});
