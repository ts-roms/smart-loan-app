/**
 * A small in-memory stand-in for the slice of Prisma the ledger reports and
 * the late-fee accrual use.
 *
 * Why this exists rather than per-test hand-rolled stubs:
 *
 * The golden tests for the N+1 fixes (docs/modernization/query-performance.md
 * F1/F3) have to pass **unchanged** against both the old implementation and
 * the new one. The old implementation reads with `findMany` and sums in
 * JavaScript; the new one pushes the sum into SQL with `groupBy`. A stub that
 * only answers `findMany` would have to be edited to answer `groupBy`, and a
 * test you edit as part of the refactor proves nothing about whether the
 * refactor changed the numbers.
 *
 * So this fake holds a fixture dataset and answers *both* query shapes from
 * it. The test states the rows and the expected report; which query the
 * repository chooses to get there is exactly the thing under test.
 *
 * `_sum` is computed with `Prisma.Decimal`, not floats, because that is what
 * Postgres `NUMERIC` does. That is the point of the §11 comparison: the old
 * path sums 2-decimal values in float and rounds, the new path sums them
 * exactly, and the golden tests are what prove the two agree.
 */

import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

export interface FakeAccount {
  id: string;
  code: string;
  name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
  normalBalance: "DEBIT" | "CREDIT";
  description?: string | null;
}

export interface FakeEntry {
  id: string;
  number: string;
  entryDate: Date;
  source: string;
  sourceRefType: string | null;
  sourceRefId: string | null;
  memo?: string | null;
}

export interface FakeLine {
  id: string;
  entryId: string;
  accountId: string;
  /** Written as strings so the fixture states exact 2-decimal NUMERIC values. */
  debit: string;
  credit: string;
  memo?: string | null;
}

export interface FakeProduct {
  lateFeeDailyRate: string;
  lateFeeCapFraction: string;
  lateFeeGraceDays: number;
}

export interface FakeSchedule {
  id: string;
  installmentNo: number;
  dueDate: Date;
  /** Exact 2-decimal string, as `Decimal(14,2)` stores it. */
  totalDue: string;
  paidInFullAt: Date | null;
  loan: {
    id: string;
    number: string;
    status: string;
    product: FakeProduct | null;
  };
}

export interface LedgerFixture {
  accounts: FakeAccount[];
  entries: FakeEntry[];
  lines: FakeLine[];
  /** Only needed by the late-fee accrual tests (F1). */
  schedules?: FakeSchedule[];
}

export interface QueryCounts {
  journalLineFindMany: number;
  journalLineGroupBy: number;
  journalEntryFindMany: number;
  accountFindMany: number;
  loanScheduleFindMany: number;
}

interface DateFilter {
  gte?: Date;
  lte?: Date;
  lt?: Date;
}

function matchesDate(value: Date, filter: DateFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.gte !== undefined && value.getTime() < filter.gte.getTime()) {
    return false;
  }
  if (filter.lte !== undefined && value.getTime() > filter.lte.getTime()) {
    return false;
  }
  if (filter.lt !== undefined && value.getTime() >= filter.lt.getTime()) {
    return false;
  }
  return true;
}

/** The `sourceRefId` shapes the repositories use: exact, or `startsWith`. */
function matchesRefId(value: string | null, cond: unknown): boolean {
  if (cond === undefined) return true;
  if (cond === null) return value === null;
  if (typeof cond === "string") return value === cond;
  if (typeof cond === "object") {
    const c = cond as { startsWith?: string; in?: string[] };
    if (c.startsWith !== undefined) {
      return value !== null && value.startsWith(c.startsWith);
    }
    if (c.in !== undefined) {
      return value !== null && c.in.includes(value);
    }
  }
  return true;
}

interface JournalEntryWhere {
  source?: string;
  sourceRefType?: string | null;
  sourceRefId?: unknown;
  OR?: JournalEntryWhere[];
  entryDate?: DateFilter;
}

function entryMatches(e: FakeEntry, where: JournalEntryWhere): boolean {
  if (where.OR) {
    if (!where.OR.some((sub) => entryMatches(e, sub))) return false;
  }
  if (where.source !== undefined && e.source !== where.source) return false;
  if (
    where.sourceRefType !== undefined &&
    e.sourceRefType !== where.sourceRefType
  ) {
    return false;
  }
  if (!matchesRefId(e.sourceRefId, where.sourceRefId)) return false;
  if (where.entryDate && !matchesDate(e.entryDate, where.entryDate)) {
    return false;
  }
  return true;
}

interface JournalLineWhere {
  accountId?: string;
  entry?: { entryDate?: DateFilter };
}

/**
 * Builds the fake. `counts` lets a test assert how many round trips the
 * repository made — which is how the N+1 fixes are pinned as fixed without
 * asserting on SQL text.
 */
export function inMemoryLedger(fixture: LedgerFixture): {
  prisma: PrismaClient;
  counts: QueryCounts;
} {
  const counts: QueryCounts = {
    journalLineFindMany: 0,
    journalLineGroupBy: 0,
    journalEntryFindMany: 0,
    accountFindMany: 0,
    loanScheduleFindMany: 0,
  };

  const accountById = new Map(fixture.accounts.map((a) => [a.id, a]));
  const entryById = new Map(fixture.entries.map((e) => [e.id, e]));

  const lineMatches = (l: FakeLine, where: JournalLineWhere): boolean => {
    if (where.accountId !== undefined && l.accountId !== where.accountId) {
      return false;
    }
    const entry = entryById.get(l.entryId);
    if (!entry) return false;
    if (
      where.entry?.entryDate &&
      !matchesDate(entry.entryDate, where.entry.entryDate)
    ) {
      return false;
    }
    return true;
  };

  /** Prisma hands back Decimal instances; `Number(...)` on them is what the code does. */
  const hydrate = (l: FakeLine, include?: { account?: boolean }) => ({
    id: l.id,
    entryId: l.entryId,
    accountId: l.accountId,
    debit: new Prisma.Decimal(l.debit),
    credit: new Prisma.Decimal(l.credit),
    memo: l.memo ?? null,
    ...(include?.account ? { account: accountById.get(l.accountId) } : {}),
  });

  const client = {
    journalLine: {
      findMany: (args: {
        where?: JournalLineWhere;
        include?: { account?: boolean };
        select?: Record<string, boolean>;
      }) => {
        counts.journalLineFindMany += 1;
        const where = args.where ?? {};
        const rows = fixture.lines
          .filter((l) => lineMatches(l, where))
          .map((l) => hydrate(l, args.include));
        return Promise.resolve(rows);
      },

      /**
       * Exactly Postgres' behaviour: group, sum in NUMERIC, and emit no row
       * for a group with no matching lines.
       */
      groupBy: (args: {
        by: string[];
        where?: JournalLineWhere;
        _sum?: { debit?: boolean; credit?: boolean };
      }) => {
        counts.journalLineGroupBy += 1;
        const where = args.where ?? {};
        const groups = new Map<
          string,
          { debit: Prisma.Decimal; credit: Prisma.Decimal }
        >();
        for (const l of fixture.lines) {
          if (!lineMatches(l, where)) continue;
          const key = l.accountId;
          const cur = groups.get(key) ?? {
            debit: new Prisma.Decimal(0),
            credit: new Prisma.Decimal(0),
          };
          cur.debit = cur.debit.plus(new Prisma.Decimal(l.debit));
          cur.credit = cur.credit.plus(new Prisma.Decimal(l.credit));
          groups.set(key, cur);
        }
        return Promise.resolve(
          [...groups.entries()].map(([accountId, sums]) => ({
            accountId,
            _sum: {
              ...(args._sum?.debit ? { debit: sums.debit } : {}),
              ...(args._sum?.credit ? { credit: sums.credit } : {}),
            },
          })),
        );
      },

      aggregate: (args: {
        where?: JournalLineWhere;
        _sum?: { debit?: boolean; credit?: boolean };
      }) => {
        counts.journalLineGroupBy += 1;
        const where = args.where ?? {};
        let debit = new Prisma.Decimal(0);
        let credit = new Prisma.Decimal(0);
        let any = false;
        for (const l of fixture.lines) {
          if (!lineMatches(l, where)) continue;
          any = true;
          debit = debit.plus(new Prisma.Decimal(l.debit));
          credit = credit.plus(new Prisma.Decimal(l.credit));
        }
        // Postgres SUM over zero rows is NULL, and Prisma surfaces that as null.
        return Promise.resolve({
          _sum: {
            ...(args._sum?.debit ? { debit: any ? debit : null } : {}),
            ...(args._sum?.credit ? { credit: any ? credit : null } : {}),
          },
        });
      },
    },

    journalEntry: {
      findMany: (args: {
        where?: JournalEntryWhere;
        include?: { lines?: { include?: { account?: boolean } } };
      }) => {
        counts.journalEntryFindMany += 1;
        const where = args.where ?? {};
        const rows = fixture.entries
          .filter((e) => entryMatches(e, where))
          .map((e) => ({
            ...e,
            ...(args.include?.lines
              ? {
                  lines: fixture.lines
                    .filter((l) => l.entryId === e.id)
                    .map((l) => hydrate(l, args.include?.lines?.include)),
                }
              : {}),
          }));
        return Promise.resolve(rows);
      },
    },

    loanSchedule: {
      findMany: (args: {
        where?: {
          paidInFullAt?: null;
          dueDate?: DateFilter;
          loan?: { status?: { in?: string[] } };
        };
      }) => {
        counts.loanScheduleFindMany += 1;
        const where = args.where ?? {};
        const rows = (fixture.schedules ?? [])
          .filter((s) => {
            if (where.paidInFullAt === null && s.paidInFullAt !== null) {
              return false;
            }
            if (!matchesDate(s.dueDate, where.dueDate)) return false;
            const statuses = where.loan?.status?.in;
            if (statuses && !statuses.includes(s.loan.status)) return false;
            return true;
          })
          .map((s) => ({
            id: s.id,
            installmentNo: s.installmentNo,
            dueDate: s.dueDate,
            totalDue: new Prisma.Decimal(s.totalDue),
            paidInFullAt: s.paidInFullAt,
            loan: {
              id: s.loan.id,
              number: s.loan.number,
              status: s.loan.status,
              product: s.loan.product
                ? {
                    lateFeeDailyRate: new Prisma.Decimal(
                      s.loan.product.lateFeeDailyRate,
                    ),
                    lateFeeCapFraction: new Prisma.Decimal(
                      s.loan.product.lateFeeCapFraction,
                    ),
                    lateFeeGraceDays: s.loan.product.lateFeeGraceDays,
                  }
                : null,
            },
          }));
        return Promise.resolve(rows);
      },
    },

    account: {
      findMany: (args?: { where?: { id?: { in?: string[] } } }) => {
        counts.accountFindMany += 1;
        const ids = args?.where?.id?.in;
        const rows = ids
          ? fixture.accounts.filter((a) => ids.includes(a.id))
          : [...fixture.accounts];
        return Promise.resolve(rows);
      },
      findUnique: (args: { where: { code?: string; id?: string } }) => {
        const found = fixture.accounts.find(
          (a) =>
            (args.where.code !== undefined && a.code === args.where.code) ||
            (args.where.id !== undefined && a.id === args.where.id),
        );
        return Promise.resolve(found ?? null);
      },
    },
  };

  return { prisma: client as unknown as PrismaClient, counts };
}
