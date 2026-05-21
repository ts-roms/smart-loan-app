/**
 * DORSI compliance repository — FRD §3.10.
 *
 * DORSI = Directors / Officers / Stockholders / Related Interests.
 *
 * Caps (computed off SystemConfig.companyTotalEquity):
 *   aggregateCap   = 15% of total equity   (across ALL DORSI loans)
 *   individualCap  = 30% of aggregate cap  = 4.5% of total equity (per borrower)
 *
 * The dashboard surface returns current utilization; the loan-apply gate
 * checks utilization + presence of a DorsiBoardApproval before allowing
 * a loan that would push past either cap.
 */

import type {
  DorsiBoardApproval,
  DorsiCategory,
  DorsiRecord,
  PrismaClient,
} from "@prisma/client";

const AGGREGATE_CAP_RATE = 0.15;
const INDIVIDUAL_CAP_RATE = 0.3; // of aggregate cap

export interface DorsiUtilization {
  /// Company total equity (the base).
  companyTotalEquity: number;
  /// Aggregate cap = 15% of equity.
  aggregateCap: number;
  /// Sum of active-loan principals across all DORSI borrowers.
  aggregateOutstanding: number;
  /// aggregateOutstanding / aggregateCap (clamped to 0..∞).
  aggregateUtilizationPct: number;
  /// Per-borrower individual cap = 30% of the aggregate cap.
  individualCap: number;
  /// Per-borrower breakdown.
  perBorrower: Array<{
    customerId: string;
    customerName: string;
    category: DorsiCategory;
    outstanding: number;
    utilizationPct: number;
  }>;
}

export interface TagInput {
  customerId: string;
  category: DorsiCategory;
  basis: string;
  taggedById: string;
}

export interface BoardApprovalInput {
  loanId: string;
  meetingDate: Date;
  minutesRef?: string;
  note?: string;
  approvedById: string;
}

export interface LoanCheckResult {
  status: "OK" | "BOARD_REQUIRED" | "NOT_DORSI";
  /// Existing utilization (pre-this-loan).
  aggregateOutstanding: number;
  aggregateCap: number;
  individualOutstanding: number;
  individualCap: number;
  projectedAggregateUtilization: number;
  projectedIndividualUtilization: number;
  /// Reason text the UI surfaces near the apply button.
  message: string;
}

export class DorsiRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // ── Register ─────────────────────────────────────────────────────────

  async tag(input: TagInput): Promise<DorsiRecord> {
    return this.prisma.dorsiRecord.upsert({
      where: { customerId: input.customerId },
      create: {
        customerId: input.customerId,
        category: input.category,
        basis: input.basis.slice(0, 500),
        taggedById: input.taggedById,
        active: true,
      },
      // Re-tagging an existing record: keep history (taggedAt etc.) but
      // flip active and basis. If you need a full history table, swap
      // this upsert for an append-only design later.
      update: {
        category: input.category,
        basis: input.basis.slice(0, 500),
        active: true,
        deactivatedAt: null,
        deactivatedById: null,
        deactivationReason: null,
      },
    });
  }

  async deactivate(
    id: string,
    input: { reason: string; deactivatedById: string },
  ): Promise<DorsiRecord> {
    return this.prisma.dorsiRecord.update({
      where: { id },
      data: {
        active: false,
        deactivatedAt: new Date(),
        deactivatedById: input.deactivatedById,
        deactivationReason: input.reason.slice(0, 500),
      },
    });
  }

  async markReviewed(id: string, reviewedById: string): Promise<DorsiRecord> {
    return this.prisma.dorsiRecord.update({
      where: { id },
      data: {
        lastReviewedAt: new Date(),
        lastReviewedById: reviewedById,
      },
    });
  }

  async listActive(): Promise<
    Array<
      DorsiRecord & {
        customer: {
          number: string;
          firstName: string;
          lastName: string;
          phone: string;
        };
      }
    >
  > {
    return this.prisma.dorsiRecord.findMany({
      where: { active: true },
      include: {
        // `number` is the CUST-YYYY-NNNNNN reference. Surfaced so UI
        // callsites can link via the human number instead of the raw UUID.
        customer: {
          select: {
            number: true,
            firstName: true,
            lastName: true,
            phone: true,
          },
        },
      },
      orderBy: { taggedAt: "desc" },
    });
  }

  async findForCustomer(customerId: string): Promise<DorsiRecord | null> {
    return this.prisma.dorsiRecord.findUnique({ where: { customerId } });
  }

  // ── Auto-screening (FRD §3.10.1) ────────────────────────────────────

  /**
   * Fuzzy name screen against the active DORSI register. Called at
   * customer onboarding and at loan creation per FRD: "LMS must
   * auto-screen and prompt manual confirmation if potential DORSI
   * matches are found".
   *
   * Strategy:
   *   - Lowercase + strip punctuation, split into tokens.
   *   - For each active DORSI record, compare token sets:
   *     - Exact match of full name → similarity 1.0 (flag)
   *     - All tokens of one name appear in the other → similarity 0.85
   *     - Substring family-name match → similarity 0.5 (review)
   *   - Return matches at similarity >= 0.5; UI surfaces a confirmation
   *     prompt with the matches listed.
   *
   * This is intentionally simple (no Levenshtein, no soundex) because
   * real DORSI lists are small (dozens of names, not thousands) so
   * exhaustive comparison is fine. If the register grows past ~500
   * records, swap in PostgreSQL's pg_trgm extension instead.
   */
  async screenByName(candidateName: string): Promise<
    Array<{
      recordId: string;
      customerId: string;
      customerName: string;
      category: DorsiCategory;
      similarity: number;
      reason: string;
    }>
  > {
    const candidateTokens = tokenize(candidateName);
    if (candidateTokens.length === 0) return [];

    const records = await this.prisma.dorsiRecord.findMany({
      where: { active: true },
      include: {
        customer: {
          select: { firstName: true, middleName: true, lastName: true },
        },
      },
    });

    const matches: Array<{
      recordId: string;
      customerId: string;
      customerName: string;
      category: DorsiCategory;
      similarity: number;
      reason: string;
    }> = [];

    for (const r of records) {
      const dorsiName = [
        r.customer.firstName,
        r.customer.middleName,
        r.customer.lastName,
      ]
        .filter(Boolean)
        .join(" ");
      const dorsiTokens = tokenize(dorsiName);

      if (dorsiTokens.length === 0) continue;

      // Exact full-name match.
      if (
        candidateTokens.length === dorsiTokens.length &&
        candidateTokens.every((t, i) => t === dorsiTokens[i])
      ) {
        matches.push({
          recordId: r.id,
          customerId: r.customerId,
          customerName: dorsiName,
          category: r.category,
          similarity: 1.0,
          reason: "Exact name match",
        });
        continue;
      }

      // Token subset match (one name's tokens all appear in the other).
      const cSet = new Set(candidateTokens);
      const dSet = new Set(dorsiTokens);
      const intersect = [...cSet].filter((t) => dSet.has(t)).length;
      const smallerCount = Math.min(cSet.size, dSet.size);
      if (smallerCount > 0 && intersect === smallerCount && intersect >= 2) {
        matches.push({
          recordId: r.id,
          customerId: r.customerId,
          customerName: dorsiName,
          category: r.category,
          similarity: 0.85,
          reason: `Token subset match (${intersect} of ${smallerCount} tokens)`,
        });
        continue;
      }

      // Last-name match (lowest confidence — same surname is a common pattern
      // for related-interest screening — spouse, parent, child).
      const candidateLast = candidateTokens[candidateTokens.length - 1];
      const dorsiLast = dorsiTokens[dorsiTokens.length - 1];
      if (
        candidateLast &&
        dorsiLast &&
        candidateLast.length >= 3 &&
        candidateLast === dorsiLast
      ) {
        matches.push({
          recordId: r.id,
          customerId: r.customerId,
          customerName: dorsiName,
          category: r.category,
          similarity: 0.5,
          reason: `Family-name match: ${candidateLast}`,
        });
      }
    }

    return matches.sort((a, b) => b.similarity - a.similarity);
  }

  // ── Utilization ──────────────────────────────────────────────────────

  /**
   * Snapshot DORSI utilization right now. Computes aggregate + per-borrower
   * exposure across all loans whose customer is currently DORSI-tagged
   * (active). Outstanding = sum of (principalDue - principalPaid) on open
   * schedule rows; consistent with how we compute outstanding elsewhere.
   */
  async utilization(): Promise<DorsiUtilization> {
    const config = await this.systemConfig();
    const totalEquity = Number(config.companyTotalEquity);
    const aggregateCap = round2(totalEquity * AGGREGATE_CAP_RATE);
    const individualCap = round2(aggregateCap * INDIVIDUAL_CAP_RATE);

    const records = await this.prisma.dorsiRecord.findMany({
      where: { active: true },
      include: {
        customer: {
          select: {
            // `number` lets the UI link with the human reference instead
            // of leaking the customer UUID into URLs.
            number: true,
            firstName: true,
            lastName: true,
            loanApplications: {
              where: { status: { in: ["DISBURSED", "ACTIVE", "DEFAULTED"] } },
              include: {
                schedule: {
                  where: { paidInFullAt: null },
                  select: { totalDue: true, principalPaid: true },
                },
              },
            },
          },
        },
      },
    });

    const perBorrower = records.map((r) => {
      let outstanding = 0;
      for (const l of r.customer.loanApplications) {
        for (const s of l.schedule) {
          outstanding += Number(s.totalDue) - Number(s.principalPaid);
        }
      }
      outstanding = round2(outstanding);
      return {
        customerId: r.customerId,
        customerNumber: r.customer.number,
        customerName: `${r.customer.firstName} ${r.customer.lastName}`,
        category: r.category,
        outstanding,
        utilizationPct: individualCap > 0 ? outstanding / individualCap : 0,
      };
    });

    const aggregateOutstanding = round2(
      perBorrower.reduce((s, b) => s + b.outstanding, 0),
    );

    return {
      companyTotalEquity: totalEquity,
      aggregateCap,
      aggregateOutstanding,
      aggregateUtilizationPct:
        aggregateCap > 0 ? aggregateOutstanding / aggregateCap : 0,
      individualCap,
      perBorrower: perBorrower.sort((a, b) => b.outstanding - a.outstanding),
    };
  }

  /**
   * Cap-check for a proposed loan. Returns OK if both caps stay within
   * thresholds after disbursing `principal`, BOARD_REQUIRED otherwise.
   */
  async checkLoan(input: {
    customerId: string;
    principal: number;
  }): Promise<LoanCheckResult> {
    const record = await this.findForCustomer(input.customerId);
    if (!record || !record.active) {
      return {
        status: "NOT_DORSI",
        aggregateOutstanding: 0,
        aggregateCap: 0,
        individualOutstanding: 0,
        individualCap: 0,
        projectedAggregateUtilization: 0,
        projectedIndividualUtilization: 0,
        message: "Customer is not DORSI.",
      };
    }
    const u = await this.utilization();
    const me = u.perBorrower.find((b) => b.customerId === input.customerId);
    const individualOutstanding = me?.outstanding ?? 0;
    const projectedAggregate =
      u.aggregateCap > 0
        ? (u.aggregateOutstanding + input.principal) / u.aggregateCap
        : 0;
    const projectedIndividual =
      u.individualCap > 0
        ? (individualOutstanding + input.principal) / u.individualCap
        : 0;
    const breaches: string[] = [];
    if (projectedAggregate > 1) breaches.push("aggregate 15% cap");
    if (projectedIndividual > 1) breaches.push("individual 30% cap");

    return {
      status: breaches.length === 0 ? "OK" : "BOARD_REQUIRED",
      aggregateOutstanding: u.aggregateOutstanding,
      aggregateCap: u.aggregateCap,
      individualOutstanding,
      individualCap: u.individualCap,
      projectedAggregateUtilization: projectedAggregate,
      projectedIndividualUtilization: projectedIndividual,
      message:
        breaches.length === 0
          ? "Within DORSI caps."
          : `Loan would breach the ${breaches.join(" + ")}. Board approval required before disburse.`,
    };
  }

  // ── Board approval ───────────────────────────────────────────────────

  async recordBoardApproval(
    input: BoardApprovalInput,
  ): Promise<DorsiBoardApproval> {
    // Snapshot the utilization at approval time so the audit trail shows
    // exactly what the board was attesting to.
    const loan = await this.prisma.loanApplication.findUnique({
      where: { id: input.loanId },
    });
    if (!loan) throw new Error("Loan not found");
    const check = await this.checkLoan({
      customerId: loan.customerId,
      principal: Number(loan.principal),
    });
    return this.prisma.dorsiBoardApproval.upsert({
      where: { loanId: input.loanId },
      create: {
        loanId: input.loanId,
        aggregateUtilizationPct: check.projectedAggregateUtilization,
        individualUtilizationPct: check.projectedIndividualUtilization,
        meetingDate: input.meetingDate,
        minutesRef: input.minutesRef,
        note: input.note?.slice(0, 500),
        approvedById: input.approvedById,
      },
      update: {
        aggregateUtilizationPct: check.projectedAggregateUtilization,
        individualUtilizationPct: check.projectedIndividualUtilization,
        meetingDate: input.meetingDate,
        minutesRef: input.minutesRef,
        note: input.note?.slice(0, 500),
        approvedById: input.approvedById,
      },
    });
  }

  async findBoardApprovalForLoan(
    loanId: string,
  ): Promise<DorsiBoardApproval | null> {
    return this.prisma.dorsiBoardApproval.findUnique({ where: { loanId } });
  }

  // ── Config ───────────────────────────────────────────────────────────

  /** Always returns the singleton row (creates it on first read). */
  async systemConfig() {
    const existing = await this.prisma.systemConfig.findUnique({
      where: { id: "singleton" },
    });
    if (existing) return existing;
    return this.prisma.systemConfig.create({
      data: { id: "singleton", companyTotalEquity: 0 },
    });
  }

  async updateCompanyTotalEquity(
    value: number,
    updatedById: string,
  ): Promise<{ companyTotalEquity: number }> {
    if (value < 0) throw new Error("companyTotalEquity must be >= 0");
    await this.prisma.systemConfig.upsert({
      where: { id: "singleton" },
      create: {
        id: "singleton",
        companyTotalEquity: value,
        updatedById,
      },
      update: { companyTotalEquity: value, updatedById },
    });
    return { companyTotalEquity: value };
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Normalize for fuzzy matching: lowercase, strip diacritics, split on spaces. */
function tokenize(name: string): string[] {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}
