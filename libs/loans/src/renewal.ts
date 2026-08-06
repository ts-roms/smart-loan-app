import { loanBalance, type ScheduleRowInput } from "./schedule-balance";

/**
 * Renewal eligibility and payoff.
 *
 * A renewal lets a borrower in good standing take a fresh loan while
 * the old one is still running: the balance of the old loan is settled
 * out of the new proceeds, and they receive the difference. It is the
 * opposite case to a restructure, which exists for loans going wrong.
 *
 * Pure, and tested, because both answers here move money. The payoff
 * figure decides how much cash the borrower actually receives, and the
 * eligibility test decides whether the lender doubles its exposure to
 * someone who has barely started repaying.
 */

/** Statuses a loan can be renewed from — it has to be live and funded. */
export const RENEWABLE_STATUSES = ["DISBURSED", "ACTIVE"] as const;

export interface RenewalCheckInput {
  status: string;
  /** The old loan's schedule, for the paid-down and arrears tests. */
  schedule: readonly (ScheduleRowInput & { dueDate: string | Date })[];
  /** Fraction of PRINCIPAL that must be repaid. 0.5 = half. */
  minPaidFraction: number;
  /** Evaluation instant; injected so the arrears test is testable. */
  now: Date;
  /** Already renewed once — the link is unique for a reason. */
  alreadyRenewed?: boolean;
}

export type RenewalCheck =
  | { eligible: true; payoffAmount: number; paidFraction: number }
  | {
      eligible: false;
      reason:
        | "NotRenewableStatus"
        | "AlreadyRenewed"
        | "InArrears"
        | "InsufficientlyPaid";
      message: string;
      /** Present where the caller can usefully show progress. */
      paidFraction?: number;
      requiredFraction?: number;
      overdueInstallments?: number;
    };

/**
 * Is this loan renewable, and if so what does settling it cost?
 *
 * The payoff is the FULL outstanding balance — principal and the
 * interest already scheduled against elapsed periods alike — because
 * that is what closing the loan actually requires. Netting only the
 * principal would leave an interest stub behind and quietly turn a
 * "renewed" loan into one that is still open for a few pesos.
 */
export function checkRenewal(input: RenewalCheckInput): RenewalCheck {
  if (!RENEWABLE_STATUSES.includes(input.status as "ACTIVE")) {
    return {
      eligible: false,
      reason: "NotRenewableStatus",
      message: `A ${input.status} loan cannot be renewed — only a live, disbursed loan can.`,
    };
  }
  if (input.alreadyRenewed) {
    return {
      eligible: false,
      reason: "AlreadyRenewed",
      message:
        "This loan has already been renewed. Renew the replacement instead.",
    };
  }

  /*
   * Arrears first, and it outranks the paid-down test on purpose. A
   * borrower can be past the threshold and still behind — paying 60% of
   * the principal early, then missing the last three months. Lending
   * again to someone currently in default is the exact failure this
   * gate exists to prevent, so it is checked before anything that could
   * excuse it.
   */
  const overdue = input.schedule.filter(
    (row) => !row.paidInFullAt && new Date(row.dueDate) < input.now,
  ).length;
  if (overdue > 0) {
    return {
      eligible: false,
      reason: "InArrears",
      message:
        overdue === 1
          ? "One instalment is overdue. Renewal requires the loan to be current."
          : `${overdue} instalments are overdue. Renewal requires the loan to be current.`,
      overdueInstallments: overdue,
    };
  }

  const balance = loanBalance(input.schedule);
  /*
   * Measured on PRINCIPAL, not total repayments. On a declining-balance
   * schedule the early instalments are mostly interest, so a borrower
   * can be a third of the way through the money paid and nowhere near a
   * third of the way through the debt. Principal is the honest measure
   * of how much of the lender's exposure has actually come back.
   */
  const paidFraction =
    balance.principalScheduled > 0
      ? balance.principalPaid / balance.principalScheduled
      : 0;

  if (paidFraction < input.minPaidFraction) {
    return {
      eligible: false,
      reason: "InsufficientlyPaid",
      message: `Only ${(paidFraction * 100).toFixed(1)}% of the principal has been repaid — renewal needs at least ${(input.minPaidFraction * 100).toFixed(1)}%.`,
      paidFraction,
      requiredFraction: input.minPaidFraction,
    };
  }

  return {
    eligible: true,
    // Rounded to centavos. The proceeds calculation subtracts this from
    // the new principal, and a fraction of a centavo left in the
    // subtraction is what leaves a loan "settled" with ₱0.004 open.
    payoffAmount: Math.round(balance.outstanding * 100) / 100,
    paidFraction,
  };
}

/**
 * What the borrower actually receives.
 *
 * Negative is possible and is NOT an error to swallow: a renewal whose
 * new principal is smaller than the old balance means the borrower owes
 * money to complete it. The caller decides whether to allow that; this
 * function's job is to report it truthfully rather than to floor it at
 * zero and hide a shortfall.
 */
export function renewalNetProceeds(
  newPrincipal: number,
  payoffAmount: number,
): number {
  return Math.round((newPrincipal - payoffAmount) * 100) / 100;
}
