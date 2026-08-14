/**
 * A small in-memory stand-in for the slice of Prisma the three whole-book
 * reads use: the aging report, the roll-rate matrix, and the collections
 * queue.
 *
 * Why this exists rather than per-test hand-rolled stubs — the same reason
 * `in-memory-ledger.ts` exists, applied to a different slice:
 *
 * The golden tests for F4 (docs/modernization/query-performance.md) have to
 * pass **unchanged** against both the old implementation and the new one.
 * The old implementations issue exactly one unbounded `findMany` each and
 * fold the whole result in JavaScript. The new ones walk the same rows in
 * bounded chunks (`orderBy id asc` + `cursor` + `take`), fold incrementally,
 * and — for the two reads that emit a row list — serve one page of the
 * result. A stub that only answered a single unbounded `findMany` would have
 * to be edited as part of the refactor, and a test you edit as part of the
 * refactor proves nothing about whether the refactor changed the numbers.
 *
 * So this fake holds a fixture book and answers *both* shapes from it:
 * `findMany` with no bounds, and `findMany` with `orderBy`/`cursor`/`skip`/
 * `take`. It also answers `count` and `groupBy`, and `$transaction` over an
 * array, because that is the house pagination idiom
 * (`libs/db/src/lib/pagination.ts`).
 *
 * `counts` lets a test assert how many round trips were made and how large
 * the largest single hydration was — which is how "no longer reads the whole
 * book in one go" is pinned without asserting on SQL text.
 *
 * Money is `Prisma.Decimal`, never float, because that is what Postgres
 * `NUMERIC` hands back and `Number(...)` at the repository boundary is
 * exactly what the code under test does.
 */

import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

// ─── Fixture shapes ────────────────────────────────────────────────────

export interface BookCustomer {
  id: string;
  firstName: string;
  lastName: string;
  city: string;
  province: string | null;
  phone: string | null;
  secondaryPhone: string | null;
  email: string | null;
  /** Most recent scorecard tier, or null when never scored. */
  creditTier?: "A" | "B" | "C" | "D" | "F" | null;
}

export interface BookSchedule {
  id: string;
  installmentNo: number;
  dueDate: Date;
  /** Exact 2-decimal strings, as `Decimal(14,2)` stores them. */
  principalDue: string;
  interestDue: string;
  totalDue: string;
  principalPaid: string;
  interestPaid: string;
  paidInFullAt: Date | null;
}

export interface BookAssignment {
  collectorId: string;
  collectorName: string;
  assignedAt: Date;
  note: string | null;
}

export interface BookPromise {
  status: "PROMISED" | "HONORED" | "BROKEN" | "CANCELLED";
  promisedDate: Date;
}

export interface BookLoan {
  id: string;
  number: string;
  customerId: string;
  productCode: string;
  /** Exact 2-decimal string — `principal` is Decimal on the wire. */
  principal: string;
  status: string;
  disbursedAt: Date | null;
  closedAt: Date | null;
  writtenOffAt: Date | null;
  schedule: BookSchedule[];
  assignment?: BookAssignment | null;
  promises?: BookPromise[];
  /** Collection notes; only the newest `createdAt` is ever read. */
  notes?: Array<{ createdAt: Date }>;
  /** Appraised collateral value, at most one of the two by construction. */
  vehicleValue?: string | null;
  propertyValue?: string | null;
}

export interface BookFixture {
  customers: BookCustomer[];
  loans: BookLoan[];
}

export interface BookQueryCounts {
  loanScheduleFindMany: number;
  loanScheduleCount: number;
  loanApplicationFindMany: number;
  loanApplicationCount: number;
  loanApplicationGroupBy: number;
  /** Largest number of rows returned by any single `findMany`. */
  largestScheduleFetch: number;
  largestLoanFetch: number;
}

// ─── Filter helpers ────────────────────────────────────────────────────

interface DateFilter {
  gte?: Date;
  lte?: Date;
  lt?: Date;
  gt?: Date;
  not?: null;
}

function matchesDate(value: Date | null, filter: unknown): boolean {
  if (filter === undefined) return true;
  if (filter === null) return value === null;
  if (filter instanceof Date) {
    return value !== null && value.getTime() === filter.getTime();
  }
  const f = filter as DateFilter;
  // `{ not: null }` — "is set at all".
  if ("not" in f && f.not === null && value === null) return false;
  if (value === null) {
    // A null column satisfies no range bound.
    return !(
      f.gte !== undefined ||
      f.lte !== undefined ||
      f.lt !== undefined ||
      f.gt !== undefined
    );
  }
  const t = value.getTime();
  if (f.gte !== undefined && t < f.gte.getTime()) return false;
  if (f.lte !== undefined && t > f.lte.getTime()) return false;
  if (f.lt !== undefined && t >= f.lt.getTime()) return false;
  if (f.gt !== undefined && t <= f.gt.getTime()) return false;
  return true;
}

function matchesString(value: string | null, cond: unknown): boolean {
  if (cond === undefined) return true;
  if (cond === null) return value === null;
  if (typeof cond === "string") return value === cond;
  if (typeof cond === "object") {
    const c = cond as {
      in?: string[];
      notIn?: string[];
      equals?: string;
      mode?: string;
    };
    if (c.in !== undefined) return value !== null && c.in.includes(value);
    if (c.notIn !== undefined)
      return value === null || !c.notIn.includes(value);
    if (c.equals !== undefined) {
      if (c.mode === "insensitive") {
        return value !== null && value.toLowerCase() === c.equals.toLowerCase();
      }
      return value === c.equals;
    }
  }
  return true;
}

/**
 * Apply `orderBy` / `cursor` / `skip` / `take` the way Prisma does.
 *
 * `cursor` is INCLUSIVE of the cursor row in Prisma; the chunked readers
 * pair it with `skip: 1`, and this reproduces both halves rather than
 * assuming the caller's convention.
 */
function applyWindow<T extends { id: string }>(
  rows: T[],
  args: {
    orderBy?: unknown;
    cursor?: { id: string };
    skip?: number;
    take?: number;
  },
  compare?: (a: T, b: T) => number,
): T[] {
  let out = [...rows];
  if (args.orderBy !== undefined && compare) out.sort(compare);
  if (args.cursor !== undefined) {
    const at = out.findIndex((r) => r.id === args.cursor!.id);
    // Prisma errors on a cursor that matches nothing; tests never do that.
    out = at === -1 ? [] : out.slice(at);
  }
  if (args.skip !== undefined) out = out.slice(args.skip);
  if (args.take !== undefined) out = out.slice(0, args.take);
  return out;
}

/** The only `orderBy` shapes these reads use. */
function loanCompare(orderBy: unknown): (a: BookLoan, b: BookLoan) => number {
  const spec: unknown = Array.isArray(orderBy) ? orderBy[0] : orderBy;
  const o = (spec ?? {}) as Record<string, string>;
  if ("id" in o) {
    return (a, b) =>
      o.id === "desc" ? b.id.localeCompare(a.id) : a.id.localeCompare(b.id);
  }
  return (a, b) => a.id.localeCompare(b.id);
}

// ─── The fake ──────────────────────────────────────────────────────────

interface FlatSchedule extends BookSchedule {
  loanId: string;
}

export function inMemoryBook(fixture: BookFixture): {
  prisma: PrismaClient;
  counts: BookQueryCounts;
} {
  const counts: BookQueryCounts = {
    loanScheduleFindMany: 0,
    loanScheduleCount: 0,
    loanApplicationFindMany: 0,
    loanApplicationCount: 0,
    loanApplicationGroupBy: 0,
    largestScheduleFetch: 0,
    largestLoanFetch: 0,
  };

  const customerById = new Map(fixture.customers.map((c) => [c.id, c]));
  const loanById = new Map(fixture.loans.map((l) => [l.id, l]));

  /** Every schedule row in the book, flattened with its loan id. */
  const allSchedules: FlatSchedule[] = fixture.loans.flatMap((l) =>
    l.schedule.map((s) => ({ ...s, loanId: l.id })),
  );

  const dec = (v: string) => new Prisma.Decimal(v);

  // ── LoanSchedule ─────────────────────────────────────────────────────

  interface ScheduleWhere {
    paidInFullAt?: null;
    dueDate?: unknown;
    loan?: { status?: { in?: string[] } };
  }

  const scheduleMatches = (s: FlatSchedule, where: ScheduleWhere): boolean => {
    if (where.paidInFullAt === null && s.paidInFullAt !== null) return false;
    if (!matchesDate(s.dueDate, where.dueDate)) return false;
    const statuses = where.loan?.status?.in;
    if (statuses) {
      const loan = loanById.get(s.loanId);
      if (!loan || !statuses.includes(loan.status)) return false;
    }
    return true;
  };

  /** Hydrate a schedule row with whatever the aging read includes. */
  const hydrateSchedule = (s: FlatSchedule, include?: unknown) => {
    const loan = loanById.get(s.loanId)!;
    const customer = customerById.get(loan.customerId)!;
    const base = {
      id: s.id,
      loanId: s.loanId,
      installmentNo: s.installmentNo,
      dueDate: s.dueDate,
      principalDue: dec(s.principalDue),
      interestDue: dec(s.interestDue),
      totalDue: dec(s.totalDue),
      principalPaid: dec(s.principalPaid),
      interestPaid: dec(s.interestPaid),
      paidInFullAt: s.paidInFullAt,
    };
    const inc = (include ?? {}) as { loan?: unknown };
    if (!inc.loan) return base;
    return {
      ...base,
      loan: {
        id: loan.id,
        number: loan.number,
        status: loan.status,
        customer: {
          firstName: customer.firstName,
          lastName: customer.lastName,
        },
      },
    };
  };

  // ── LoanApplication ──────────────────────────────────────────────────

  interface LoanWhere {
    id?: unknown;
    status?: unknown;
    customerId?: unknown;
    disbursedAt?: unknown;
    schedule?: { some?: { paidInFullAt?: null; dueDate?: unknown } };
    collectionAssignment?: unknown;
    customer?: {
      province?: unknown;
      city?: unknown;
    };
  }

  const loanMatches = (l: BookLoan, where: LoanWhere): boolean => {
    if (!matchesString(l.id, where.id)) return false;
    if (!matchesString(l.status, where.status)) return false;
    if (!matchesString(l.customerId, where.customerId)) return false;
    if (!matchesDate(l.disbursedAt, where.disbursedAt)) return false;

    if (where.schedule?.some) {
      const cond = where.schedule.some;
      const any = l.schedule.some((s) => {
        if (cond.paidInFullAt === null && s.paidInFullAt !== null) return false;
        if (!matchesDate(s.dueDate, cond.dueDate)) return false;
        return true;
      });
      if (!any) return false;
    }

    if (where.collectionAssignment !== undefined) {
      const assignment = l.assignment ?? null;
      // `collectionAssignment: null` is Prisma's "has no related row".
      if (where.collectionAssignment === null) {
        if (assignment !== null) return false;
      } else {
        const cond = where.collectionAssignment as { collectorId?: string };
        if (
          cond.collectorId !== undefined &&
          assignment?.collectorId !== cond.collectorId
        ) {
          return false;
        }
      }
    }

    if (where.customer) {
      const customer = customerById.get(l.customerId);
      if (!customer) return false;
      if (!matchesString(customer.province, where.customer.province)) {
        return false;
      }
      if (!matchesString(customer.city, where.customer.city)) return false;
    }

    return true;
  };

  /**
   * Hydrate a loan for whichever of the two read shapes asked for it:
   * `select` (roll-rate — scalars plus a reduced schedule) or `include`
   * (the queue — scalars plus six relations).
   */
  const hydrateLoan = (
    l: BookLoan,
    args: {
      select?: Record<string, unknown>;
      include?: Record<string, unknown>;
    },
  ) => {
    const customer = customerById.get(l.customerId)!;

    if (args.select) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(args.select)) {
        if (key === "schedule") {
          const sel = (
            args.select.schedule as { select?: Record<string, unknown> }
          ).select;
          out.schedule = l.schedule.map((s) => {
            const row: Record<string, unknown> = {};
            for (const f of Object.keys(sel ?? {})) {
              row[f] =
                f === "totalDue"
                  ? dec(s.totalDue)
                  : (s as unknown as Record<string, unknown>)[f];
            }
            return row;
          });
        } else {
          out[key] = (l as unknown as Record<string, unknown>)[key];
        }
      }
      return out;
    }

    // `include` — every LoanApplication scalar survives, which is what the
    // queue's `...rest` spread relies on.
    const scalars = {
      id: l.id,
      number: l.number,
      customerId: l.customerId,
      productCode: l.productCode,
      principal: dec(l.principal),
      status: l.status,
      disbursedAt: l.disbursedAt,
      closedAt: l.closedAt,
      writtenOffAt: l.writtenOffAt,
    };

    const inc = args.include ?? {};
    const out: Record<string, unknown> = { ...scalars };

    if (inc.customer) {
      out.customer = {
        firstName: customer.firstName,
        lastName: customer.lastName,
        city: customer.city,
        province: customer.province,
        phone: customer.phone,
        secondaryPhone: customer.secondaryPhone,
        email: customer.email,
        creditScores: customer.creditTier
          ? [{ tier: customer.creditTier }]
          : [],
      };
    }

    if (inc.schedule) {
      const spec = inc.schedule as {
        where?: { paidInFullAt?: null };
        orderBy?: { dueDate?: string };
      };
      let rows = l.schedule;
      if (spec.where?.paidInFullAt === null) {
        rows = rows.filter((s) => s.paidInFullAt === null);
      }
      rows = [...rows].sort(
        (a, b) => a.dueDate.getTime() - b.dueDate.getTime(),
      );
      out.schedule = rows.map((s) => ({
        id: s.id,
        loanId: l.id,
        installmentNo: s.installmentNo,
        dueDate: s.dueDate,
        principalDue: dec(s.principalDue),
        interestDue: dec(s.interestDue),
        totalDue: dec(s.totalDue),
        principalPaid: dec(s.principalPaid),
        interestPaid: dec(s.interestPaid),
        paidInFullAt: s.paidInFullAt,
      }));
    }

    if (inc.collectionAssignment) {
      out.collectionAssignment = l.assignment
        ? {
            collectorId: l.assignment.collectorId,
            assignedAt: l.assignment.assignedAt,
            note: l.assignment.note,
            collector: { name: l.assignment.collectorName },
          }
        : null;
    }

    if (inc.promisesToPay) {
      out.promisesToPay = (l.promises ?? []).map((p) => ({
        status: p.status,
        promisedDate: p.promisedDate,
      }));
    }

    if (inc.collectionNotes) {
      // `orderBy createdAt desc, take 1` — newest only.
      const sorted = [...(l.notes ?? [])].sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
      );
      out.collectionNotes = sorted.slice(0, 1).map((n) => ({
        createdAt: n.createdAt,
      }));
    }

    if (inc.vehicle) {
      out.vehicle = l.vehicleValue
        ? { appraisedValue: dec(l.vehicleValue) }
        : null;
    }
    if (inc.property) {
      out.property = l.propertyValue
        ? { appraisedValue: dec(l.propertyValue) }
        : null;
    }

    return out;
  };

  const client = {
    loanSchedule: {
      findMany: (args: {
        where?: ScheduleWhere;
        include?: unknown;
        orderBy?: unknown;
        cursor?: { id: string };
        skip?: number;
        take?: number;
      }) => {
        counts.loanScheduleFindMany += 1;
        const matched = allSchedules.filter((s) =>
          scheduleMatches(s, args.where ?? {}),
        );
        const windowed = applyWindow(matched, args, (a, b) =>
          a.id.localeCompare(b.id),
        );
        counts.largestScheduleFetch = Math.max(
          counts.largestScheduleFetch,
          windowed.length,
        );
        return Promise.resolve(
          windowed.map((s) => hydrateSchedule(s, args.include)),
        );
      },

      count: (args: { where?: ScheduleWhere }) => {
        counts.loanScheduleCount += 1;
        return Promise.resolve(
          allSchedules.filter((s) => scheduleMatches(s, args.where ?? {}))
            .length,
        );
      },
    },

    loanApplication: {
      findMany: (args: {
        where?: LoanWhere;
        select?: Record<string, unknown>;
        include?: Record<string, unknown>;
        orderBy?: unknown;
        cursor?: { id: string };
        skip?: number;
        take?: number;
      }) => {
        counts.loanApplicationFindMany += 1;
        const matched = fixture.loans.filter((l) =>
          loanMatches(l, args.where ?? {}),
        );
        const windowed = applyWindow(matched, args, loanCompare(args.orderBy));
        counts.largestLoanFetch = Math.max(
          counts.largestLoanFetch,
          windowed.length,
        );
        return Promise.resolve(windowed.map((l) => hydrateLoan(l, args)));
      },

      count: (args: { where?: LoanWhere }) => {
        counts.loanApplicationCount += 1;
        return Promise.resolve(
          fixture.loans.filter((l) => loanMatches(l, args.where ?? {})).length,
        );
      },

      /** `by: ["customerId","status"]`, `_count: { _all: true }`. */
      groupBy: (args: {
        by: string[];
        where?: LoanWhere;
        _count?: { _all?: boolean };
      }) => {
        counts.loanApplicationGroupBy += 1;
        const groups = new Map<
          string,
          { row: Record<string, unknown>; n: number }
        >();
        for (const l of fixture.loans) {
          if (!loanMatches(l, args.where ?? {})) continue;
          const row: Record<string, unknown> = {};
          for (const k of args.by) {
            row[k] = (l as unknown as Record<string, unknown>)[k];
          }
          const key = args.by.map((k) => String(row[k])).join(" ");
          const cur = groups.get(key);
          if (cur) cur.n += 1;
          else groups.set(key, { row, n: 1 });
        }
        return Promise.resolve(
          [...groups.values()].map((g) => ({
            ...g.row,
            _count: { _all: g.n },
          })),
        );
      },
    },

    /**
     * The house pagination idiom wraps `[findMany, count]` in one
     * transaction so the rows and the total describe the same snapshot.
     * Prisma accepts an array of already-started promises here.
     */
    $transaction: (ops: unknown) => {
      if (Array.isArray(ops)) return Promise.all(ops);
      return (ops as (c: unknown) => unknown)(client);
    },
  };

  return { prisma: client as unknown as PrismaClient, counts };
}
