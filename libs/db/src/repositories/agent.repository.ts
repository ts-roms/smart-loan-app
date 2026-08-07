/**
 * Field agents and their books.
 *
 * An agent originates loans and is paid a fraction of the principal on
 * each one that funds. This repository owns the directory (who the
 * agents are, what rate they carry) and the read side of the book (what
 * they brought in, what they earned).
 *
 * The commission arithmetic itself is NOT here — it lives in
 * @loan/loans/agent-commission, pure and tested, so the rules can be
 * reasoned about without a database. Assignment and posting live on
 * LoanRepository, next to the loan lifecycle they belong to.
 */

import {
  agentBookTotals,
  assertValidCommissionRate,
  type AgentBookTotals,
} from "@loan/loans";
import type { Prisma, PrismaClient } from "@prisma/client";

import { nextAgentNumber } from "../lib/reference-numbers";

export interface AgentCreateInput {
  /** Must already exist, must not already be an agent. */
  userId: string;
  /** Fraction of principal. Omit or null to inherit the product's rate. */
  commissionRate?: number | null;
  territory?: string | null;
  notes?: string | null;
  createdById?: string | null;
}

export interface AgentUpdateInput {
  commissionRate?: number | null;
  territory?: string | null;
  notes?: string | null;
  active?: boolean;
}

export interface AgentListFilter {
  /** Omit for all; true/false to filter. */
  active?: boolean;
  /** Case-insensitive match on agent number, name, email or territory. */
  q?: string;
  take?: number;
  skip?: number;
}

export interface AgentSummary {
  id: string;
  number: string;
  userId: string;
  name: string;
  email: string;
  /** Null means "inherit the product's rate". */
  commissionRate: number | null;
  territory: string | null;
  notes: string | null;
  active: boolean;
  deactivatedAt: string | null;
  createdAt: string;
  /** Rolled up from their assigned loans. */
  totals: AgentBookTotals;
}

export interface AgentBookLoan {
  id: string;
  number: string;
  status: string;
  productCode: string;
  principal: number;
  submittedAt: string;
  disbursedAt: string | null;
  customerName: string;
  customerNumber: string;
  /** Frozen at assignment. Null on rows assigned before a rate existed. */
  commissionRate: number | null;
  commissionAmount: number | null;
  /** Set once the commission was booked to the ledger, at disbursement. */
  commissionPostedAt: string | null;
}

export class AgentNotFoundError extends Error {
  constructor(idOrNumber: string) {
    super(`No agent matches "${idOrNumber}".`);
    this.name = "AgentNotFoundError";
  }
}

export class UserAlreadyAgentError extends Error {
  constructor(readonly userId: string) {
    super(
      "That user is already registered as an agent. One agent per login — a second row would make their book ambiguous.",
    );
    this.name = "UserAlreadyAgentError";
  }
}

export class NoAgentProfileError extends Error {
  constructor() {
    super(
      "You are signed in, but no agent profile is linked to this account. Ask an administrator to register you as an agent.",
    );
    this.name = "NoAgentProfileError";
  }
}

const num = (d: Prisma.Decimal | null | undefined): number | null =>
  d === null || d === undefined ? null : Number(d);

/** Accepts a uuid or an "AGT-2026-000001" number. */
const agentWhere = (idOrNumber: string): Prisma.AgentWhereInput =>
  idOrNumber.startsWith("AGT-") ? { number: idOrNumber } : { id: idOrNumber };

/** The row shape both `list` and `get` load, mapped once. */
type AgentRow = {
  id: string;
  number: string;
  userId: string;
  commissionRate: Prisma.Decimal | null;
  territory: string | null;
  notes: string | null;
  active: boolean;
  deactivatedAt: Date | null;
  createdAt: Date;
  user: { name: string; email: string };
  loans: { status: string; agentCommissionAmount: Prisma.Decimal | null }[];
};

function toSummary(a: AgentRow): AgentSummary {
  return {
    id: a.id,
    number: a.number,
    userId: a.userId,
    name: a.user.name,
    email: a.user.email,
    commissionRate: num(a.commissionRate),
    territory: a.territory,
    notes: a.notes,
    active: a.active,
    deactivatedAt: a.deactivatedAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
    totals: agentBookTotals(
      a.loans.map((l) => ({
        status: l.status,
        commissionAmount: num(l.agentCommissionAmount),
      })),
    ),
  };
}

export class AgentRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: AgentCreateInput) {
    // Validated here as well as in the API schema. A rate above 1 is
    // almost always a percentage typed where a fraction belongs, and
    // this is the last place to catch it before it is frozen onto loans.
    if (input.commissionRate !== null && input.commissionRate !== undefined) {
      assertValidCommissionRate(input.commissionRate);
    }
    const existing = await this.prisma.agent.findUnique({
      where: { userId: input.userId },
      select: { id: true },
    });
    if (existing) throw new UserAlreadyAgentError(input.userId);

    return this.prisma.agent.create({
      data: {
        number: await nextAgentNumber(this.prisma),
        userId: input.userId,
        commissionRate: input.commissionRate ?? null,
        territory: input.territory ?? null,
        notes: input.notes ?? null,
        createdById: input.createdById ?? null,
      },
    });
  }

  async update(idOrNumber: string, input: AgentUpdateInput) {
    if (input.commissionRate !== null && input.commissionRate !== undefined) {
      assertValidCommissionRate(input.commissionRate);
    }
    const found = await this.prisma.agent.findFirst({
      where: agentWhere(idOrNumber),
      select: { id: true, active: true },
    });
    if (!found) throw new AgentNotFoundError(idOrNumber);

    const data: Prisma.AgentUpdateInput = {};
    if (input.commissionRate !== undefined) {
      data.commissionRate = input.commissionRate;
    }
    if (input.territory !== undefined) data.territory = input.territory;
    if (input.notes !== undefined) data.notes = input.notes;
    if (input.active !== undefined && input.active !== found.active) {
      data.active = input.active;
      /*
       * Stamped on the way down, cleared on the way back up. An agent
       * reinstated in March should not still read "deactivated in
       * January" — the date is about the CURRENT state, not a log.
       * The audit trail of who did what lives in AuditEvent.
       */
      data.deactivatedAt = input.active ? null : new Date();
    }

    return this.prisma.agent.update({ where: { id: found.id }, data });
  }

  /**
   * The directory, each row carrying its rolled-up book.
   *
   * The loans come back as a slim projection — status and the frozen
   * commission, nothing more — because that is all the totals need. A
   * directory of thirty agents must not drag thirty full loan lists.
   */
  async list(filter: AgentListFilter = {}): Promise<AgentSummary[]> {
    const where: Prisma.AgentWhereInput = {};
    if (filter.active !== undefined) where.active = filter.active;
    if (filter.q?.trim()) {
      const q = filter.q.trim();
      where.OR = [
        { number: { contains: q, mode: "insensitive" } },
        { territory: { contains: q, mode: "insensitive" } },
        { user: { name: { contains: q, mode: "insensitive" } } },
        { user: { email: { contains: q, mode: "insensitive" } } },
      ];
    }

    const rows = await this.prisma.agent.findMany({
      where,
      orderBy: [{ active: "desc" }, { number: "asc" }],
      take: filter.take ?? 100,
      skip: filter.skip ?? 0,
      include: {
        user: { select: { id: true, name: true, email: true } },
        loans: { select: { status: true, agentCommissionAmount: true } },
      },
    });

    return rows.map(toSummary);
  }

  async get(idOrNumber: string): Promise<AgentSummary> {
    const a = await this.prisma.agent.findFirst({
      where: agentWhere(idOrNumber),
      include: {
        user: { select: { id: true, name: true, email: true } },
        loans: { select: { status: true, agentCommissionAmount: true } },
      },
    });
    if (!a) throw new AgentNotFoundError(idOrNumber);
    return toSummary(a);
  }

  /** The agent profile for a login, or null if that user isn't an agent. */
  async findByUserId(userId: string) {
    return this.prisma.agent.findUnique({ where: { userId } });
  }

  /**
   * Resolve the signed-in user to their agent id.
   *
   * Every self-scoped endpoint goes through here rather than trusting an
   * agent id from the request. `agents.self` says "you may see your own
   * book"; it is this lookup, not the permission, that decides whose.
   */
  async requireOwnAgentId(userId: string): Promise<string> {
    const a = await this.prisma.agent.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!a) throw new NoAgentProfileError();
    return a.id;
  }

  /**
   * One agent's assisted loans, newest first.
   *
   * Every status, not just the funded ones. An agent needs to see what
   * is still in the pipeline as much as what has paid out, and a
   * rejected application is information they should have too.
   */
  async book(
    agentId: string,
    opts: { take?: number; skip?: number; status?: string } = {},
  ): Promise<{ loans: AgentBookLoan[]; totals: AgentBookTotals }> {
    const where: Prisma.LoanApplicationWhereInput = { agentId };
    if (opts.status) where.status = opts.status as never;

    const [rows, all] = await Promise.all([
      this.prisma.loanApplication.findMany({
        where,
        orderBy: { submittedAt: "desc" },
        take: opts.take ?? 50,
        skip: opts.skip ?? 0,
        select: {
          id: true,
          number: true,
          status: true,
          productCode: true,
          principal: true,
          submittedAt: true,
          disbursedAt: true,
          agentCommissionRate: true,
          agentCommissionAmount: true,
          agentCommissionPostedAt: true,
          customer: {
            select: { number: true, firstName: true, lastName: true },
          },
        },
      }),
      /*
       * Totals over the WHOLE book, not the page. An agent paging
       * through their loans must not watch their earnings change as
       * they click "next" — the figure at the top is what they have
       * made, not what is visible.
       *
       * Also deliberately unfiltered by `opts.status`: filtering the
       * table to REJECTED should not report earnings of zero.
       */
      this.prisma.loanApplication.findMany({
        where: { agentId },
        select: { status: true, agentCommissionAmount: true },
      }),
    ]);

    return {
      loans: rows.map((l) => ({
        id: l.id,
        number: l.number,
        status: l.status,
        productCode: l.productCode,
        principal: Number(l.principal),
        submittedAt: l.submittedAt.toISOString(),
        disbursedAt: l.disbursedAt?.toISOString() ?? null,
        customerName: `${l.customer.firstName} ${l.customer.lastName}`,
        customerNumber: l.customer.number,
        commissionRate: num(l.agentCommissionRate),
        commissionAmount: num(l.agentCommissionAmount),
        commissionPostedAt: l.agentCommissionPostedAt?.toISOString() ?? null,
      })),
      totals: agentBookTotals(
        all.map((l) => ({
          status: l.status,
          commissionAmount: num(l.agentCommissionAmount),
        })),
      ),
    };
  }
}
