/**
 * Default chart of accounts. Codes follow the conventional 4-digit scheme
 * (1xxx assets, 2xxx liabilities, 3xxx equity, 4xxx income, 5xxx expense).
 *
 * The `auto-posting` flow references these by *code*, so renaming an
 * account is safe but changing its code is not.
 */

export type AccountTypeCode =
  "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
export type NormalBalanceCode = "DEBIT" | "CREDIT";

export interface ChartAccount {
  code: string;
  name: string;
  type: AccountTypeCode;
  normalBalance: NormalBalanceCode;
  description?: string;
  /** System accounts are referenced from auto-posting code — do not delete. */
  system?: boolean;
}

/** Codes that auto-posting depends on. Keep in sync with `posting.ts`. */
export const ACCOUNT_CODES = {
  CASH: "1000",
  LOANS_RECEIVABLE: "1100",
  INTEREST_RECEIVABLE: "1200",
  ALLOWANCE_FOR_DOUBTFUL: "1190",
  OWNERS_EQUITY: "3000",
  /**
   * Money received from a borrower beyond everything their loan still owes.
   * We hold it as a liability (we owe them a refund, or we hold it against a
   * future obligation) rather than pushing Loans Receivable negative.
   */
  CUSTOMER_ADVANCES: "2100",
  INTEREST_INCOME: "4000",
  FEE_INCOME: "4100",
  BAD_DEBT_EXPENSE: "5000",
  /**
   * IFRS 9 expected-credit-loss movement. Kept distinct from BAD_DEBT_EXPENSE
   * (which we book only on write-off) so the income statement separates
   * realized losses from provisioning.
   */
  IMPAIRMENT_LOSS: "5050",
  OPERATING_EXPENSE: "5100",

  // ── Cooperative fund accounts ──────────────────────────────────────
  /** Member CBU is equity (members own a stake in the coop). */
  CAPITAL_BUILD_UP: "3050",
  /** Mortuary fund — death-benefit pool. Liability until paid out. */
  MORTUARY_FUND: "2200",
  /** Emergency fund — short-term member assistance pool. */
  EMERGENCY_FUND: "2210",
  /** Members' voluntary savings — repayable on demand. */
  MEMBERS_SAVINGS: "2300",
  /** External capital provider deposits (NGO/parent coop) — repayable. */
  BIG_BROTHER_CAPITAL: "2400",
  /** Non-loan income (dividends, donations, fees other than processing). */
  OTHER_INCOME: "4200",
  /**
   * Commission owed to a field agent for a loan they originated. A
   * liability from the moment the loan is disbursed until the agent is
   * actually paid — the expense is recognized at disbursement, the cash
   * leaves later, and those are two different events.
   */
  AGENT_COMMISSION_PAYABLE: "2500",
  /** Commission expense — the cost of originating through agents. */
  AGENT_COMMISSION_EXPENSE: "5150",
} as const;

export const DEFAULT_CHART_OF_ACCOUNTS: ChartAccount[] = [
  {
    code: ACCOUNT_CODES.CASH,
    name: "Cash",
    type: "ASSET",
    normalBalance: "DEBIT",
    description: "Cash on hand / bank.",
    system: true,
  },
  {
    code: ACCOUNT_CODES.LOANS_RECEIVABLE,
    name: "Loans Receivable",
    type: "ASSET",
    normalBalance: "DEBIT",
    description: "Outstanding principal owed by borrowers.",
    system: true,
  },
  {
    code: ACCOUNT_CODES.ALLOWANCE_FOR_DOUBTFUL,
    name: "Allowance for Doubtful Accounts",
    type: "ASSET",
    normalBalance: "CREDIT",
    description: "Contra-asset against loans receivable.",
    system: true,
  },
  {
    code: ACCOUNT_CODES.INTEREST_RECEIVABLE,
    name: "Interest Receivable",
    type: "ASSET",
    normalBalance: "DEBIT",
    description: "Accrued but unpaid interest.",
    system: true,
  },
  {
    code: ACCOUNT_CODES.CUSTOMER_ADVANCES,
    name: "Customer Advance Payments",
    type: "LIABILITY",
    normalBalance: "CREDIT",
    description:
      "Payments received in excess of everything a loan still owes. Refundable to the borrower or applied to a future obligation.",
    system: true,
  },
  {
    code: ACCOUNT_CODES.AGENT_COMMISSION_PAYABLE,
    name: "Agent Commission Payable",
    type: "LIABILITY",
    normalBalance: "CREDIT",
    description:
      "Commission earned by field agents on disbursed loans and not yet paid out to them.",
    system: true,
  },
  {
    code: ACCOUNT_CODES.AGENT_COMMISSION_EXPENSE,
    name: "Agent Commission Expense",
    type: "EXPENSE",
    normalBalance: "DEBIT",
    description:
      "Cost of originating loans through field agents. Recognized in full at disbursement.",
    system: true,
  },
  {
    code: ACCOUNT_CODES.OWNERS_EQUITY,
    name: "Owner's Equity",
    type: "EQUITY",
    normalBalance: "CREDIT",
    description: "Owner contributions and retained earnings.",
    system: true,
  },
  {
    code: ACCOUNT_CODES.INTEREST_INCOME,
    name: "Interest Income",
    type: "INCOME",
    normalBalance: "CREDIT",
    description: "Interest earned from loans.",
    system: true,
  },
  {
    code: ACCOUNT_CODES.FEE_INCOME,
    name: "Fee Income",
    type: "INCOME",
    normalBalance: "CREDIT",
    description: "Processing and service fees.",
    system: true,
  },
  {
    code: ACCOUNT_CODES.BAD_DEBT_EXPENSE,
    name: "Bad Debt Expense",
    type: "EXPENSE",
    normalBalance: "DEBIT",
    description: "Loans written off as uncollectible.",
    system: true,
  },
  {
    code: ACCOUNT_CODES.IMPAIRMENT_LOSS,
    name: "Impairment Loss (ECL)",
    type: "EXPENSE",
    normalBalance: "DEBIT",
    description:
      "Movement in the IFRS 9 expected-credit-loss allowance — separate from realized write-offs.",
    system: true,
  },
  {
    code: ACCOUNT_CODES.OPERATING_EXPENSE,
    name: "Operating Expense",
    type: "EXPENSE",
    normalBalance: "DEBIT",
    description: "General operating expenses.",
    system: true,
  },

  // ── Cooperative accounts ─────────────────────────────────────────
  {
    code: ACCOUNT_CODES.CAPITAL_BUILD_UP,
    name: "Capital Build-Up",
    type: "EQUITY",
    normalBalance: "CREDIT",
    description:
      "Members' equity stake. Funded by per-period CBU contributions.",
    system: true,
  },
  {
    code: ACCOUNT_CODES.MORTUARY_FUND,
    name: "Mortuary Fund Payable",
    type: "LIABILITY",
    normalBalance: "CREDIT",
    description:
      "Death-benefit pool — released to beneficiaries on a member death event.",
    system: true,
  },
  {
    code: ACCOUNT_CODES.EMERGENCY_FUND,
    name: "Emergency Fund Payable",
    type: "LIABILITY",
    normalBalance: "CREDIT",
    description:
      "Short-term emergency assistance pool — drawn down via FundWithdrawal.",
    system: true,
  },
  {
    code: ACCOUNT_CODES.MEMBERS_SAVINGS,
    name: "Members Savings Payable",
    type: "LIABILITY",
    normalBalance: "CREDIT",
    description: "Voluntary member savings — repayable on demand.",
    system: true,
  },
  {
    code: ACCOUNT_CODES.BIG_BROTHER_CAPITAL,
    name: "Big Brother Capital",
    type: "LIABILITY",
    normalBalance: "CREDIT",
    description:
      "External capital from a sponsor / parent coop. Period-bound; expected to be returned at expiry.",
    system: true,
  },
  {
    code: ACCOUNT_CODES.OTHER_INCOME,
    name: "Other Income",
    type: "INCOME",
    normalBalance: "CREDIT",
    description:
      "Non-loan, non-processing income: dividends, donations, misc receipts.",
    system: true,
  },
];

/**
 * Map a Cooperative "Source of Funds" bucket string to its GL account code.
 * Anything unrecognized falls back to Cash (1000) so a stray bucket name
 * doesn't fail the post — the journal entry still balances, just hits a
 * less-specific account.
 */
export function bucketToAccount(bucket: string): string {
  switch (bucket.toUpperCase()) {
    case "CAPITAL_BUILD_UP":
    case "CBU":
      return ACCOUNT_CODES.CAPITAL_BUILD_UP;
    case "MORTUARY_FUND":
    case "MORTUARY":
      return ACCOUNT_CODES.MORTUARY_FUND;
    case "EMERGENCY_FUND":
    case "EMERGENCY":
      return ACCOUNT_CODES.EMERGENCY_FUND;
    case "SAVINGS":
      return ACCOUNT_CODES.MEMBERS_SAVINGS;
    case "BIG_BROTHER":
      return ACCOUNT_CODES.BIG_BROTHER_CAPITAL;
    case "OTHER_INCOME":
    case "OTHER":
      return ACCOUNT_CODES.OTHER_INCOME;
    case "GENERAL":
    case "CASH":
    default:
      return ACCOUNT_CODES.CASH;
  }
}
