/**
 * Bank reconciliation persistence + auto-match helper.
 *
 * A reconciliation cycle:
 *   1. Someone imports a bank statement CSV (BankStatement + lines).
 *   2. `autoMatch` walks the unmatched lines and tries to pair each with
 *      a LoanPayment (for credits) or a recent LoanApplication disburse
 *      (for debits) by amount + date proximity + optional reference.
 *   3. Whatever doesn't match auto stays unmatched until a human picks
 *      a target via the UI (or marks it MANUAL with a note).
 */

import type {
  BankStatement,
  BankStatementLine,
  PrismaClient,
  Prisma,
} from "@prisma/client";

export interface BankStatementCreateInput {
  label: string;
  bankAccount: string;
  periodStart: Date;
  periodEnd: Date;
  openingBalance: number;
  closingBalance: number;
  importedById?: string;
}

export interface BankStatementLineInput {
  txnDate: Date;
  description: string;
  amount: number;
  reference?: string | null;
  runningBalance?: number | null;
}

export interface AutoMatchResult {
  matchedLines: number;
  matchedAmount: number;
  /** Per-line match decision — useful for UI feedback after import. */
  details: Array<{
    lineId: string;
    matchedType: string | null;
    matchedRefId: string | null;
    note?: string;
  }>;
}

export class BankReconciliationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  list(): Promise<BankStatement[]> {
    return this.prisma.bankStatement.findMany({
      orderBy: { periodStart: "desc" },
    });
  }

  findById(
    id: string,
  ): Promise<(BankStatement & { lines: BankStatementLine[] }) | null> {
    return this.prisma.bankStatement.findUnique({
      where: { id },
      include: { lines: { orderBy: { txnDate: "asc" } } },
    });
  }

  async create(
    input: BankStatementCreateInput,
    lines: BankStatementLineInput[],
  ): Promise<BankStatement> {
    return this.prisma.bankStatement.create({
      data: {
        ...input,
        openingBalance: input.openingBalance as unknown as Prisma.Decimal,
        closingBalance: input.closingBalance as unknown as Prisma.Decimal,
        lines: {
          createMany: {
            data: lines.map((l) => ({
              txnDate: l.txnDate,
              description: l.description,
              amount: l.amount as unknown as Prisma.Decimal,
              reference: l.reference ?? null,
              runningBalance: (l.runningBalance ??
                null) as unknown as Prisma.Decimal | null,
            })),
          },
        },
      },
    });
  }

  /**
   * Best-effort auto-match. Conservative: only matches when both amount
   * AND a strong secondary signal (reference equality OR date within
   * +/- 2 days AND no other candidate) line up. Anything ambiguous goes
   * to manual.
   */
  async autoMatch(statementId: string): Promise<AutoMatchResult> {
    const lines = await this.prisma.bankStatementLine.findMany({
      where: { statementId, matchedAt: null },
    });
    const details: AutoMatchResult["details"] = [];
    let matchedLines = 0;
    let matchedAmount = 0;

    for (const line of lines) {
      const amount = Number(line.amount);
      const isCredit = amount > 0;
      const windowStart = new Date(line.txnDate);
      windowStart.setDate(windowStart.getDate() - 2);
      const windowEnd = new Date(line.txnDate);
      windowEnd.setDate(windowEnd.getDate() + 2);

      if (isCredit) {
        // Credit (money in) → most likely a customer payment.
        // Prefer reference equality, fall back to amount + date proximity.
        const candidates = await this.prisma.loanPayment.findMany({
          where: {
            amount: amount as unknown as Prisma.Decimal,
            paidOn: { gte: windowStart, lte: windowEnd },
          },
          take: 5,
        });
        let match: (typeof candidates)[number] | undefined;
        if (line.reference) {
          match = candidates.find((p) => p.reference === line.reference);
        }
        if (!match && candidates.length === 1) match = candidates[0];
        if (match) {
          await this.prisma.bankStatementLine.update({
            where: { id: line.id },
            data: {
              matchedType: "LoanPayment",
              matchedRefId: match.id,
              matchedAt: new Date(),
            },
          });
          matchedLines++;
          matchedAmount += amount;
          details.push({
            lineId: line.id,
            matchedType: "LoanPayment",
            matchedRefId: match.id,
          });
          continue;
        }
      } else {
        // Debit (money out) → likely a disbursement. Compare against
        // loans disbursed in the window, by principal amount.
        const candidates = await this.prisma.loanApplication.findMany({
          where: {
            principal: Math.abs(amount) as unknown as Prisma.Decimal,
            disbursedAt: { gte: windowStart, lte: windowEnd },
          },
          take: 5,
        });
        if (candidates.length === 1) {
          await this.prisma.bankStatementLine.update({
            where: { id: line.id },
            data: {
              matchedType: "LoanDisbursement",
              matchedRefId: candidates[0]!.id,
              matchedAt: new Date(),
            },
          });
          matchedLines++;
          matchedAmount += Math.abs(amount);
          details.push({
            lineId: line.id,
            matchedType: "LoanDisbursement",
            matchedRefId: candidates[0]!.id,
          });
          continue;
        }
      }
      details.push({ lineId: line.id, matchedType: null, matchedRefId: null });
    }
    return { matchedLines, matchedAmount, details };
  }

  async manualMatch(
    lineId: string,
    input: { type: string; refId?: string; note?: string; userId: string },
  ): Promise<BankStatementLine> {
    return this.prisma.bankStatementLine.update({
      where: { id: lineId },
      data: {
        matchedType: input.type,
        matchedRefId: input.refId ?? null,
        matchedAt: new Date(),
        matchedById: input.userId,
        matchNote: input.note ?? null,
      },
    });
  }

  /**
   * Scored match candidates for a single line. Returns the top N by score.
   * Same heuristics as autoMatch but doesn't apply anything — the human
   * picks via the drawer UI. Score is a 0..1 confidence indicator:
   *   1.0  exact amount + reference equality
   *   0.85 exact amount within date window + sole candidate
   *   0.7  exact amount within date window
   *   0.5  partial / fuzzier (kept for future, currently unused)
   */
  async candidatesFor(
    lineId: string,
    take = 5,
  ): Promise<
    Array<{
      type: "LoanPayment" | "LoanDisbursement";
      refId: string;
      score: number;
      label: string;
      detail: string;
    }>
  > {
    const line = await this.prisma.bankStatementLine.findUnique({
      where: { id: lineId },
    });
    if (!line) return [];
    const amount = Number(line.amount);
    const isCredit = amount > 0;
    const windowStart = new Date(line.txnDate);
    windowStart.setDate(windowStart.getDate() - 2);
    const windowEnd = new Date(line.txnDate);
    windowEnd.setDate(windowEnd.getDate() + 2);

    if (isCredit) {
      const candidates = await this.prisma.loanPayment.findMany({
        where: {
          amount: amount as unknown as Prisma.Decimal,
          paidOn: { gte: windowStart, lte: windowEnd },
        },
        include: { loan: { select: { number: true, customerId: true } } },
        take,
      });
      return candidates.map((p) => {
        const exactRef = line.reference && p.reference === line.reference;
        const sole = candidates.length === 1;
        const score = exactRef ? 1.0 : sole ? 0.85 : 0.7;
        return {
          type: "LoanPayment" as const,
          refId: p.id,
          score,
          label: `Payment on ${p.loan.number}`,
          detail: `${p.paidOn.toISOString().slice(0, 10)} · ref ${p.reference ?? "—"}`,
        };
      });
    } else {
      const absAmount = Math.abs(amount);
      const candidates = await this.prisma.loanApplication.findMany({
        where: {
          principal: absAmount as unknown as Prisma.Decimal,
          disbursedAt: { gte: windowStart, lte: windowEnd },
        },
        take,
      });
      return candidates.map((l) => {
        const sole = candidates.length === 1;
        const score = sole ? 0.85 : 0.7;
        return {
          type: "LoanDisbursement" as const,
          refId: l.id,
          score,
          label: `Disbursement ${l.number}`,
          detail: `${l.disbursedAt?.toISOString().slice(0, 10) ?? "—"} · principal ${absAmount.toFixed(2)}`,
        };
      });
    }
  }

  async unmatch(lineId: string): Promise<BankStatementLine> {
    return this.prisma.bankStatementLine.update({
      where: { id: lineId },
      data: {
        matchedType: null,
        matchedRefId: null,
        matchedAt: null,
        matchedById: null,
        matchNote: null,
      },
    });
  }

  /**
   * Per-statement reconciliation summary. Used by the UI dashboard and
   * the "close out reconciliation" button.
   */
  async summary(statementId: string): Promise<{
    totalLines: number;
    matched: number;
    unmatched: number;
    matchedAmount: number;
    unmatchedAmount: number;
  }> {
    const lines = await this.prisma.bankStatementLine.findMany({
      where: { statementId },
      select: { amount: true, matchedAt: true },
    });
    const matched = lines.filter((l) => l.matchedAt !== null);
    const unmatched = lines.filter((l) => l.matchedAt === null);
    return {
      totalLines: lines.length,
      matched: matched.length,
      unmatched: unmatched.length,
      matchedAmount: matched.reduce((s, l) => s + Number(l.amount), 0),
      unmatchedAmount: unmatched.reduce((s, l) => s + Number(l.amount), 0),
    };
  }
}
