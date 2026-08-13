import { describe, expect, it } from "vitest";

import {
  buildProductProfitabilityReport,
  fromCentavos,
  toCentavos,
  type LoanProductRef,
  type ProfitabilityEntryInput,
} from "./profitability";

/**
 * A small book, every figure verifiable by hand.
 *
 * Products: SALARY (loans L1, L2) and BUSINESS (loan B1).
 *
 *   E1  L1 disbursement, ₱200 origination fee withheld
 *         Dr 1100 10000 / Cr 1000 9800 / Cr 4100 200
 *   E2  L1 payment, ₱150 interest portion
 *         Dr 1000 500 / Cr 4000 150 / Cr 1100 350
 *   E3  L1 late-fee accrual ₱25
 *         Dr 1100 25 / Cr 4100 25
 *   E4  L1 penalty waive ₱10
 *         Dr 4100 10 / Cr 1100 10
 *   E5  B1 interest accrual ₱300
 *         Dr 1200 300 / Cr 4000 300
 *   E6  B1 write-off ₱4000
 *         Dr 5000 4000 / Cr 1100 4000
 *   E7  manual entry against Interest Income, no loan — ₱77
 *         Dr 1000 77 / Cr 4000 77
 *   E8  L2 interest accrual ₱120  +  E9 its REVERSAL (both in window)
 *
 * Expected:
 *   SALARY    interest 150.00 (E2; E8+E9 cancel)  fee 200.00 (E1)
 *             lateFee 15.00 (25 − 10)             writeOff 0.00
 *             net 365.00                          loans {L1, L2} = 2
 *   BUSINESS  interest 300.00  fee 0  lateFee 0   writeOff 4000.00
 *             net −3700.00                        loans {B1} = 1
 *   UNATTR    interest 77.00, net 77.00, entryCount 1
 *   TOTALS    interest 527.00  fee 200.00  lateFee 15.00
 *             writeOff 4000.00  net −3258.00
 */

const FROM = new Date("2026-07-01T00:00:00.000Z");
const TO = new Date("2026-07-31T23:59:59.999Z");

const LOANS: LoanProductRef[] = [
  { loanId: "L1", productCode: "SALARY", productName: "Salary Loan" },
  { loanId: "L2", productCode: "SALARY", productName: "Salary Loan" },
  { loanId: "B1", productCode: "BUSINESS", productName: "Business Loan" },
];

function line(accountCode: string, debit: string, credit: string) {
  return { accountCode, debit, credit };
}

const BOOK: ProfitabilityEntryInput[] = [
  {
    entryId: "E1",
    source: "LOAN_DISBURSEMENT",
    sourceRefType: "LoanApplication",
    sourceRefId: "L1",
    loanId: "L1",
    inWindow: true,
    lines: [
      line("1100", "10000.00", "0"),
      line("1000", "0", "9800.00"),
      line("4100", "0", "200.00"),
    ],
  },
  {
    entryId: "E2",
    source: "LOAN_PAYMENT",
    sourceRefType: "LoanPayment",
    sourceRefId: "P1",
    loanId: "L1",
    inWindow: true,
    lines: [
      line("1000", "500.00", "0"),
      line("4000", "0", "150.00"),
      line("1100", "0", "350.00"),
    ],
  },
  {
    entryId: "E3",
    source: "LATE_FEE_ACCRUAL",
    sourceRefType: "LoanScheduleLateFee",
    sourceRefId: "S1:2026-07",
    loanId: "L1",
    inWindow: true,
    lines: [line("1100", "25.00", "0"), line("4100", "0", "25.00")],
  },
  {
    entryId: "E4",
    source: "PENALTY_WAIVE",
    sourceRefType: "PenaltyWaiver",
    sourceRefId: "W1",
    loanId: "L1",
    inWindow: true,
    lines: [line("4100", "10.00", "0"), line("1100", "0", "10.00")],
  },
  {
    entryId: "E5",
    source: "INTEREST_ACCRUAL",
    sourceRefType: "LoanScheduleAccrual",
    sourceRefId: "S9",
    loanId: "B1",
    inWindow: true,
    lines: [line("1200", "300.00", "0"), line("4000", "0", "300.00")],
  },
  {
    entryId: "E6",
    source: "MANUAL",
    sourceRefType: "LoanWriteOff",
    sourceRefId: "B1",
    loanId: "B1",
    inWindow: true,
    lines: [line("5000", "4000.00", "0"), line("1100", "0", "4000.00")],
  },
  {
    entryId: "E7",
    source: "MANUAL",
    sourceRefType: null,
    sourceRefId: null,
    loanId: null,
    inWindow: true,
    lines: [line("1000", "77.00", "0"), line("4000", "0", "77.00")],
  },
  {
    entryId: "E8",
    source: "INTEREST_ACCRUAL",
    sourceRefType: "LoanScheduleAccrual",
    sourceRefId: "S2",
    loanId: "L2",
    inWindow: true,
    lines: [line("1200", "120.00", "0"), line("4000", "0", "120.00")],
  },
  {
    // Reversal of E8 — same window, so the pair must cancel exactly.
    // loanId is null on purpose: the repository does not resolve
    // "JournalEntry" refs; the builder follows the pointer.
    entryId: "E9",
    source: "REVERSAL",
    sourceRefType: "JournalEntry",
    sourceRefId: "E8",
    loanId: null,
    inWindow: true,
    lines: [line("1200", "0", "120.00"), line("4000", "120.00", "0")],
  },
];

describe("buildProductProfitabilityReport", () => {
  const report = buildProductProfitabilityReport(BOOK, LOANS, FROM, TO);

  it("attributes each product's figures exactly", () => {
    expect(report.products).toEqual([
      {
        productCode: "BUSINESS",
        productName: "Business Loan",
        loanCount: 1,
        interestIncome: "300.00",
        feeIncome: "0.00",
        lateFeeIncome: "0.00",
        writeOffLoss: "4000.00",
        net: "-3700.00",
      },
      {
        productCode: "SALARY",
        productName: "Salary Loan",
        loanCount: 2,
        interestIncome: "150.00",
        feeIncome: "200.00",
        lateFeeIncome: "15.00",
        writeOffLoss: "0.00",
        net: "365.00",
      },
    ]);
  });

  it("reports the no-product entry in the unattributed bucket, not dropped", () => {
    expect(report.unattributed).toEqual({
      entryCount: 1,
      interestIncome: "77.00",
      feeIncome: "0.00",
      lateFeeIncome: "0.00",
      writeOffLoss: "0.00",
      net: "77.00",
    });
  });

  it("totals = product rows + unattributed", () => {
    expect(report.totals).toEqual({
      interestIncome: "527.00",
      feeIncome: "200.00",
      lateFeeIncome: "15.00",
      writeOffLoss: "4000.00",
      net: "-3258.00",
    });
  });

  it("echoes the period", () => {
    expect(report.from).toBe(FROM.toISOString());
    expect(report.to).toBe(TO.toISOString());
  });

  it("an in-window reversal pair cancels — SALARY interest is E2 alone", () => {
    const salary = report.products.find((p) => p.productCode === "SALARY")!;
    expect(salary.interestIncome).toBe("150.00");
    // …and L2 still counts as a touched loan even though its net is zero.
    expect(salary.loanCount).toBe(2);
  });
});

describe("reversal of an out-of-window original", () => {
  it("inherits the original's loan AND late-fee classification", () => {
    // The original late-fee accrual predates the window; the repository
    // supplies it lines-free (inWindow: false) purely so the reversal can
    // be attributed. Only the reversal's own amount counts: −25 late fee.
    const entries: ProfitabilityEntryInput[] = [
      {
        entryId: "OLD",
        source: "LATE_FEE_ACCRUAL",
        sourceRefType: "LoanScheduleLateFee",
        sourceRefId: "S1:2026-05",
        loanId: "L1",
        inWindow: false,
        lines: [],
      },
      {
        entryId: "REV",
        source: "REVERSAL",
        sourceRefType: "JournalEntry",
        sourceRefId: "OLD",
        loanId: null,
        inWindow: true,
        lines: [line("4100", "25.00", "0"), line("1100", "0", "25.00")],
      },
    ];
    const report = buildProductProfitabilityReport(entries, LOANS, FROM, TO);
    expect(report.products).toHaveLength(1);
    expect(report.products[0]).toMatchObject({
      productCode: "SALARY",
      lateFeeIncome: "-25.00",
      feeIncome: "0.00",
      net: "-25.00",
    });
    expect(report.unattributed.entryCount).toBe(0);
  });

  it("a reversal whose original is missing lands in unattributed, generic fee bucket", () => {
    const entries: ProfitabilityEntryInput[] = [
      {
        entryId: "REV",
        source: "REVERSAL",
        sourceRefType: "JournalEntry",
        sourceRefId: "GONE",
        loanId: null,
        inWindow: true,
        lines: [line("4100", "25.00", "0"), line("1100", "0", "25.00")],
      },
    ];
    const report = buildProductProfitabilityReport(entries, LOANS, FROM, TO);
    expect(report.products).toHaveLength(0);
    expect(report.unattributed).toMatchObject({
      entryCount: 1,
      feeIncome: "-25.00",
      lateFeeIncome: "0.00",
      net: "-25.00",
    });
  });
});

describe("centavo arithmetic (§11)", () => {
  it("round-trips decimal strings exactly", () => {
    expect(toCentavos("1234.56")).toBe(123456);
    expect(toCentavos("1234.5")).toBe(123450);
    expect(toCentavos("1234")).toBe(123400);
    expect(toCentavos("0")).toBe(0);
    expect(toCentavos("-12.34")).toBe(-1234);
    expect(fromCentavos(123456)).toBe("1234.56");
    expect(fromCentavos(-5)).toBe("-0.05");
    expect(fromCentavos(0)).toBe("0.00");
  });

  it("rejects what Decimal(14,2) cannot produce", () => {
    expect(() => toCentavos("1.234")).toThrow(/Not a money amount/);
    expect(() => toCentavos("1e3")).toThrow(/Not a money amount/);
    expect(() => toCentavos("")).toThrow(/Not a money amount/);
  });

  it("sums 0.10 + 0.20 without float drift", () => {
    const entries: ProfitabilityEntryInput[] = [
      {
        entryId: "A",
        source: "LOAN_PAYMENT",
        sourceRefType: "LoanPayment",
        sourceRefId: "P1",
        loanId: "L1",
        inWindow: true,
        lines: [line("4000", "0", "0.10"), line("4000", "0", "0.20")],
      },
    ];
    const report = buildProductProfitabilityReport(entries, LOANS, FROM, TO);
    expect(report.products[0]!.interestIncome).toBe("0.30");
    expect(report.totals.net).toBe("0.30");
  });
});

describe("empty book", () => {
  it("returns a well-formed all-zero report", () => {
    const report = buildProductProfitabilityReport([], [], FROM, TO);
    expect(report.products).toEqual([]);
    expect(report.unattributed).toEqual({
      entryCount: 0,
      interestIncome: "0.00",
      feeIncome: "0.00",
      lateFeeIncome: "0.00",
      writeOffLoss: "0.00",
      net: "0.00",
    });
    expect(report.totals.net).toBe("0.00");
  });
});
