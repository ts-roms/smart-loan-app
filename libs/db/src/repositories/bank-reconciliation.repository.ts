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

/**
 * One record, one bank line. Thrown when a match would give a second
 * line the same payment or disbursement.
 */
export class BankLineAlreadyMatchedError extends Error {
  readonly code = "ALREADY_MATCHED" as const;
  constructor(
    readonly lineId: string,
    description: string,
    txnDate: Date,
  ) {
    super(
      `That record is already reconciled against another line — "${description}" on ${txnDate.toISOString().slice(0, 10)}. Unmatch that one first, or this statement has a duplicate the bank sent twice.`,
    );
    this.name = "BankLineAlreadyMatchedError";
  }
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
  /**
   * Reference ids already claimed by some other bank line.
   *
   * Reconciliation is a one-to-one correspondence, and nothing enforced
   * it: the candidate queries look up payments by amount and date and
   * never asked whether a payment was already matched. Two identical
   * credits on a statement against one recorded payment therefore both
   * matched it, and the statement reported itself fully reconciled
   * while a real deposit was unaccounted for.
   *
   * That is the exact discrepancy this feature exists to surface — a
   * duplicated bank credit, or a receipt someone forgot to key — so
   * silently absorbing it is worse than leaving the line unmatched.
   *
   * Scoped by type as well as id: a LoanPayment id and a
   * LoanApplication id can never collide today, but the pair is what
   * `matchedType`/`matchedRefId` means and matching on the id alone
   * would be a trap for whoever adds the third kind.
   */
  private async claimedRefIds(
    type: string,
    exceptLineId?: string,
  ): Promise<Set<string>> {
    const rows = await this.prisma.bankStatementLine.findMany({
      where: {
        matchedType: type,
        matchedRefId: { not: null },
        ...(exceptLineId ? { id: { not: exceptLineId } } : {}),
      },
      select: { matchedRefId: true },
    });
    return new Set(rows.map((r) => r.matchedRefId!));
  }

  async autoMatch(statementId: string): Promise<AutoMatchResult> {
    const lines = await this.prisma.bankStatementLine.findMany({
      where: { statementId, matchedAt: null },
    });
    const details: AutoMatchResult["details"] = [];
    let matchedLines = 0;
    let matchedAmount = 0;

    /*
     * Finding F2 — but NOT the fix rejection R2 proposed.
     *
     * R2 reads this call as loop-invariant: "called once per statement line
     * with no per-line argument — the result is identical every time". The
     * argument is per-line-invariant but it is not loop-invariant, because
     * the loop WRITES the very columns `claimedRefIds` reads. Every match
     * below sets `matchedType`/`matchedRefId`, and the next iteration's read
     * picks that up. That feedback is what stops two statement lines
     * reconciling against one payment — the discrepancy the comment above
     * `claimedRefIds` says this feature exists to surface — and it also lets
     * an earlier match narrow a later line to a single candidate.
     *
     * Hoisting the call and reusing one frozen set therefore changes results,
     * in both directions. Two golden tests in
     * bank-reconciliation.repository.automatch.golden.test.ts fail if it is.
     *
     * So: read once, then keep the sets in step with our own writes. Same
     * answers, 2 queries instead of 2N.
     *
     * What this does NOT preserve is visibility of claims made by a
     * *concurrent* process mid-loop. That is worth stating plainly rather
     * than glossing: there is no unique constraint on
     * (matchedType, matchedRefId), so the old per-line re-read was never a
     * guarantee either — between its SELECT and its UPDATE another run could
     * claim the same payment. It narrowed an already-open window; this
     * widens it back to the length of one autoMatch run. Closing it properly
     * needs a unique index, which is a schema change and its own review.
     */
    const claimedPayments = await this.claimedRefIds("LoanPayment");
    const claimedLoans = await this.claimedRefIds("LoanDisbursement");

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
        const candidates = (
          await this.prisma.loanPayment.findMany({
            where: {
              amount: amount as unknown as Prisma.Decimal,
              paidOn: { gte: windowStart, lte: windowEnd },
            },
            take: 5,
          })
        ).filter((p) => !claimedPayments.has(p.id));
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
          // Keeps the set in step with the write we just made, exactly as
          // the old per-line re-read did.
          claimedPayments.add(match.id);
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
        const candidates = (
          await this.prisma.loanApplication.findMany({
            where: {
              principal: Math.abs(amount) as unknown as Prisma.Decimal,
              disbursedAt: { gte: windowStart, lte: windowEnd },
            },
            take: 5,
          })
        ).filter((l) => !claimedLoans.has(l.id));
        if (candidates.length === 1) {
          await this.prisma.bankStatementLine.update({
            where: { id: line.id },
            data: {
              matchedType: "LoanDisbursement",
              matchedRefId: candidates[0]!.id,
              matchedAt: new Date(),
            },
          });
          claimedLoans.add(candidates[0]!.id);
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
    /*
     * The last word, not the candidate list's.
     *
     * The drawer hides claimed rows, but a stale page or a direct API
     * call can still ask for one — and reconciling two bank lines to a
     * single payment is precisely the discrepancy this feature is meant
     * to reveal. Refused with the offending line named so the operator
     * can go look at it.
     *
     * `MANUAL` and other free-text types carry no refId and are exempt:
     * they mean "explained, not tied to a record" (a bank fee, an
     * interest credit), and several lines may legitimately be explained
     * the same way.
     */
    if (input.refId) {
      const claimedBy = await this.prisma.bankStatementLine.findFirst({
        where: {
          matchedType: input.type,
          matchedRefId: input.refId,
          id: { not: lineId },
        },
        select: { id: true, txnDate: true, description: true },
      });
      if (claimedBy) {
        throw new BankLineAlreadyMatchedError(
          claimedBy.id,
          claimedBy.description,
          claimedBy.txnDate,
        );
      }
    }
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
      // Exclude what another line already claims — offering a candidate
      // the write path will refuse is worse than offering none.
      const claimed = await this.claimedRefIds("LoanPayment", lineId);
      const candidates = (
        await this.prisma.loanPayment.findMany({
          where: {
            amount: amount as unknown as Prisma.Decimal,
            paidOn: { gte: windowStart, lte: windowEnd },
          },
          include: { loan: { select: { number: true, customerId: true } } },
          take,
        })
      ).filter((p) => !claimed.has(p.id));
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
      const claimedLoans = await this.claimedRefIds("LoanDisbursement", lineId);
      const candidates = (
        await this.prisma.loanApplication.findMany({
          where: {
            principal: absAmount as unknown as Prisma.Decimal,
            disbursedAt: { gte: windowStart, lte: windowEnd },
          },
          take,
        })
      ).filter((l) => !claimedLoans.has(l.id));
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
