/**
 * Fixture data for the automated smoke test (`e2e.sh`).
 *
 * Creates eleven customers spanning every branch of the New Loan picker's
 * ranking, plus the loans that put them there:
 *
 *   tier 0  no live loan      PICKER-001..005  (none / closed / rejected / submitted)
 *   tier 1  live loan         PICKER-006..008  (active / disbursed / approved)
 *   tier 2  prior default     PICKER-009..011  (defaulted / written off / both)
 *
 * Loans in a post-release status also get the state release would have
 * produced: an installment schedule (same amortization math as
 * `LoanRepository.disburse`), a disbursement date placed so the status
 * makes sense (an ACTIVE loan is three months in and current; a DEFAULTED
 * one is eight months in with nothing paid), and matching LoanPayment
 * rows for whatever the schedule shows as settled, and the journal
 * entries release would have posted. Without this the fixtures sat in a
 * state production can't produce — released loans with no schedule — so
 * the amortization ledger self-hid and list balances were null on
 * exactly the loans meant to exercise them.
 *
 * Journal entries were once deliberately omitted, on the grounds that
 * accumulating disbursement entries on every reseed would pollute the
 * accounting reports. That was true when the sweep below left the old
 * entries behind; it isn't now that it clears them first. What the
 * omission cost was worse: payments credited Loans Receivable while
 * nothing had ever debited it, so the dev ledger carried the asset at a
 * CREDIT balance of ₱59,906.94 and every accounting page rendered
 * nonsense. A released loan with no entry is exactly the contradiction
 * this section exists to prevent.
 *
 * Re-runnable: every PICKER-* row is deleted and recreated (schedules and
 * payments cascade with the loan), so the smoke test starts from a known
 * state on each run. That matters because the payments section settles a
 * real payment against a fixture loan on every run.
 *
 * DEV ONLY. Points at whatever DATABASE_URL resolves to, and deletes rows.
 * Never run against anything you care about.
 *
 *   pnpm --filter @loan/db exec dotenv -e ../../.env -- tsx ../../docs/smoke-tests/fixtures.ts
 */
import {
  PrismaClient,
  type LoanProduct,
  type LoanStatus,
} from "@prisma/client";

// Relative import on purpose: docs/ is not a workspace package, so the
// "@loan/loans" alias doesn't resolve from here. tsx follows the source
// import fine, and it's the exact function the real disburse path uses.
import {
  ACCOUNT_CODES,
  buildEntry,
  loanDisbursementEntry,
  loanPaymentEntry,
} from "../../libs/accounting/src/index";
import { AccountingRepository } from "../../libs/db/src/repositories/accounting.repository";
import {
  computeAmortizationFor,
  computeFees,
  daysBetweenInstallments,
} from "../../libs/loans/src/index";

const prisma = new PrismaClient();
/*
 * The same repository the real disburse path posts through, so the
 * entries are built by the same code and validated by the same
 * `buildEntry` balance check. `postIfAbsent` keys on the source ref, so
 * a half-finished run can be repeated without doubling anything.
 */
const accounting = new AccountingRepository(prisma);

/** Fixture loans are all ₱50,000 over 12 months at 24%. */
const PRINCIPAL = 50_000;

/**
 * The money the coop lends has to come from somewhere.
 *
 * Without this the fixtures disburse ₱338,625 the books never received,
 * and Cash sits at a net CREDIT — an asset on the wrong side, on every
 * accounting page. Not a rounding artefact: a lender with no funding
 * entry is describing a business that lent money it did not have.
 *
 * Dated before the earliest disbursement (the CLOSED loan is fourteen
 * months back) so no loan is funded out of capital that had not arrived.
 */
const OPENING_CAPITAL = 1_000_000;
const OPENING_CAPITAL_REF = "fixture-opening-capital";
/**
 * Exported so `sweep-orphaned-entries` can recognise it. This entry has
 * no owning domain row by design, which is exactly what that script
 * treats as an orphan unless told otherwise.
 */
export const FIXTURE_CAPITAL_REF_TYPE = "FixtureOpeningCapital";

/** name, loan statuses to attach */
const PEOPLE: Array<[string, LoanStatus[]]> = [
  ["Clara Clean", []], // tier 0 — never borrowed
  ["Nina Newbie", []], // tier 0
  ["Paolo Paidoff", ["CLOSED"]], // tier 0 — history, nothing running
  ["Rita Rejected", ["REJECTED"]], // tier 0 — never granted
  ["Sam Submitted", ["SUBMITTED"]], // tier 0 — not granted yet
  ["Andres Active", ["ACTIVE"]], // tier 1
  ["Dina Disbursed", ["DISBURSED"]], // tier 1
  ["Aldo Approved", ["APPROVED"]], // tier 1
  ["Danilo Default", ["DEFAULTED"]], // tier 2
  ["Wilma Writeoff", ["WRITTEN_OFF"]], // tier 2
  ["Rico Redemption", ["DEFAULTED", "ACTIVE"]], // tier 2 — both flags true
];

async function main() {
  const officer = await prisma.user.findFirstOrThrow({
    where: { role: "LOAN_OFFICER" },
  });
  const product = await prisma.loanProduct.findFirstOrThrow();

  /*
   * Clean out a previous run. Loans first — Customer has onDelete:
   * Restrict.
   *
   * Deleted by OWNING CUSTOMER, not by loan number. Matching
   * "PICKER-*" on the loan looks equivalent and isn't: anything the API
   * derives from a fixture loan gets a real LN-YYYY-NNNNNN number, so a
   * restructure (which closes the original and creates a replacement)
   * leaves a loan on a fixture customer that this sweep would skip. The
   * customer delete then fails the FK and the whole reseed aborts —
   * leaving no fixtures at all and every picker assertion failing with
   * flags that look like a product bug.
   */
  const fixtureCustomers = await prisma.customer.findMany({
    where: { number: { startsWith: "PICKER-" } },
    select: { id: true },
  });
  const fixtureCustomerIds = fixtureCustomers.map((c) => c.id);
  if (fixtureCustomerIds.length > 0) {
    /*
     * The books first, and by hand.
     *
     * JournalEntry links back through `sourceRefId` — a plain string,
     * no foreign key, because a general ledger is meant to be immutable:
     * you reverse an entry, you never delete it. Which is right in
     * production, where nothing deletes a loan, and wrong here, where
     * this script deletes them on every run. The entries survived their
     * loans and left balances with no source behind them: six orphaned
     * payment entries were sitting on ₱600 of Customer Advance Payments,
     * a liability the coop was carrying to nobody.
     *
     * Collected before the cascade takes the ids away.
     */
    const doomed = await prisma.loanApplication.findMany({
      where: { customerId: { in: fixtureCustomerIds } },
      select: { id: true, payments: { select: { id: true } } },
    });
    const refIds = doomed.flatMap((l) => [
      l.id,
      ...l.payments.map((p) => p.id),
    ]);
    if (refIds.length > 0) {
      const entries = await prisma.journalEntry.findMany({
        where: { sourceRefId: { in: refIds } },
        select: { id: true },
      });
      const entryIds = entries.map((e) => e.id);
      if (entryIds.length > 0) {
        await prisma.journalLine.deleteMany({
          where: { entryId: { in: entryIds } },
        });
        await prisma.journalEntry.deleteMany({
          where: { id: { in: entryIds } },
        });
      }

      /*
       * And the notifications, for the same reason and with the same
       * root cause: `Notification.refId` is another plain string with no
       * foreign key, so a notification outlives the loan it was raised
       * about and its link leads to "this loan no longer exists".
       *
       * Every loan notification in this repo's dev database — all
       * sixteen of them — pointed at a loan a previous reseed had
       * deleted. Clicking the bell was guaranteed to dead-end.
       */
      await prisma.notification.deleteMany({
        where: { refType: "LoanApplication", refId: { in: refIds } },
      });
    }
    await prisma.loanApplication.deleteMany({
      where: { customerId: { in: fixtureCustomerIds } },
    });
  }
  // Belt and braces: a PICKER-* loan whose customer was already removed.
  await prisma.loanApplication.deleteMany({
    where: { number: { startsWith: "PICKER-" } },
  });
  await prisma.customer.deleteMany({
    where: { number: { startsWith: "PICKER-" } },
  });

  /*
   * Fund the book before lending from it. `postIfAbsent` keyed on a
   * fixed ref makes this idempotent, so reseeding does not stack
   * capital injections on top of each other.
   */
  await accounting.postIfAbsent(
    buildEntry({
      entryDate: addMonths(new Date(), -15),
      source: "MANUAL",
      sourceRefType: FIXTURE_CAPITAL_REF_TYPE,
      sourceRefId: OPENING_CAPITAL_REF,
      memo: "Fixture: opening capital",
      lines: [
        { accountCode: ACCOUNT_CODES.CASH, debit: OPENING_CAPITAL, credit: 0 },
        {
          accountCode: ACCOUNT_CODES.OWNERS_EQUITY,
          debit: 0,
          credit: OPENING_CAPITAL,
        },
      ],
    }),
    { postedById: officer.id },
  );

  let n = 0;
  for (const [fullName, statuses] of PEOPLE) {
    const [firstName, lastName] = fullName.split(" ");
    n += 1;
    const seq = String(n).padStart(3, "0");
    const customer = await prisma.customer.create({
      data: {
        number: `PICKER-${seq}`,
        firstName: firstName!,
        lastName: lastName!,
        dateOfBirth: new Date("1990-01-01"),
        phone: `0917000${String(n).padStart(4, "0")}`,
        address: "1 Test St",
        city: "Manila",
        governmentIdType: "NATIONAL_ID",
        governmentIdNumber: `NID-${String(n).padStart(6, "0")}`,
        employmentStatus: "EMPLOYED",
        monthlyIncome: 30000,
        kycStatus: "VERIFIED",
      },
    });

    let k = 0;
    for (const status of statuses) {
      k += 1;
      const loan = await prisma.loanApplication.create({
        data: {
          number: `PICKER-${seq}-${k}`,
          customerId: customer.id,
          productCode: product.code,
          principal: 50000,
          termMonths: 12,
          annualInterestRate: 0.24,
          status,
          submittedById: officer.id,
        },
      });
      await seedPostReleaseState(loan.id, status, product, officer.id);
    }
    console.log(`${customer.number} ${fullName} → [${statuses.join(", ")}]`);
  }
}

// ─── Post-release realism ────────────────────────────────────────────
//
// A loan whose status says "released" needs the state release produces,
// or every surface that reads the schedule sees a contradiction. Each
// status gets a disbursement date that makes its story true:
//
//   DISBURSED     released today — schedule exists, nothing due yet.
//   ACTIVE        three months in, every due installment paid: a
//                 healthy, current borrower.
//   CLOSED        a full term plus a little in the past, all twelve
//                 installments settled on their due dates.
//   DEFAULTED     eight months in, not one payment: rows 1–8 overdue,
//                 which is what the status claims happened.
//   WRITTEN_OFF   like DEFAULTED but older, with the write-off fields
//                 stamped — the lender gave up collecting.

/** How far back the release happened, per status. */
const MONTHS_SINCE_RELEASE: Partial<Record<LoanStatus, number>> = {
  DISBURSED: 0,
  ACTIVE: 3,
  CLOSED: 14,
  DEFAULTED: 8,
  WRITTEN_OFF: 10,
};

function addMonths(base: Date, months: number): Date {
  const d = new Date(base);
  d.setMonth(d.getMonth() + months);
  return d;
}

async function seedPostReleaseState(
  loanId: string,
  status: LoanStatus,
  product: LoanProduct,
  officerId: string,
) {
  const monthsAgo = MONTHS_SINCE_RELEASE[status];
  if (monthsAgo === undefined) return; // pre-release status — no schedule

  const now = new Date();
  const disbursedAt = addMonths(now, -monthsAgo);

  // Same math and the same due-date walk as LoanRepository.disburse,
  // just anchored at the backdated release instead of today.
  const rows = computeAmortizationFor(PRINCIPAL, 0.24, 12, {
    method: product.interestMethod,
    frequency: product.paymentFrequency,
  });
  const periodInc = daysBetweenInstallments(product.paymentFrequency);
  const dueDateOf = (installmentNo: number): Date => {
    const due = new Date(disbursedAt);
    if (periodInc === "MONTH") due.setMonth(due.getMonth() + installmentNo);
    else due.setDate(due.getDate() + periodInc * installmentNo);
    return due;
  };

  // Which installments the status says were paid.
  const isPaid = (dueDate: Date): boolean => {
    if (status === "CLOSED") return true;
    if (status === "ACTIVE") return dueDate.getTime() <= now.getTime();
    return false; // DISBURSED (nothing due), DEFAULTED / WRITTEN_OFF (nothing paid)
  };

  const schedule = rows.map((row, idx) => {
    const dueDate = dueDateOf(idx + 1);
    const paid = isPaid(dueDate);
    return {
      loanId,
      installmentNo: idx + 1,
      dueDate,
      principalDue: row.principal,
      interestDue: row.interest,
      totalDue: row.payment,
      principalPaid: paid ? row.principal : 0,
      interestPaid: paid ? row.interest : 0,
      paidInFullAt: paid ? dueDate : null,
    };
  });
  await prisma.loanSchedule.createMany({ data: schedule });

  /*
   * The disbursement entry, before any payment can credit the
   * receivable it creates. Fees come from the same `computeFees` the
   * real path uses, so Fee Income lands here too rather than being
   * quietly folded into cash.
   */
  const loan = await prisma.loanApplication.findUniqueOrThrow({
    where: { id: loanId },
    select: { number: true },
  });
  const fees = computeFees(PRINCIPAL, {
    processingFeeRate: Number(product.processingFeeRate),
    processingFeeFlat: Number(product.processingFeeFlat),
    documentaryStampRate: Number(product.documentaryStampRate),
  });
  await accounting.postIfAbsent(
    loanDisbursementEntry({
      loanId,
      loanNumber: loan.number,
      principal: PRINCIPAL,
      feeTotal: fees.total,
      disbursedAt,
    }),
    { postedById: officerId },
  );

  // One payment per settled installment, on its due date, so the
  // statement PDF's payment history agrees with the schedule instead of
  // reading "No payments recorded" against paid rows.
  //
  // Created one at a time rather than with createMany, because each
  // needs its own journal entry and `createMany` does not hand back the
  // ids those entries key on.
  const paidRows = schedule.filter((s) => s.paidInFullAt);
  for (const row of paidRows) {
    const payment = await prisma.loanPayment.create({
      data: {
        loanId,
        amount: row.totalDue,
        paidOn: row.dueDate,
        reference: `FIXTURE-${row.installmentNo}`,
        recordedById: officerId,
      },
    });
    /*
     * The split is taken from the schedule row rather than recomputed.
     * These installments are settled exactly, so principal and interest
     * are already known — and running them back through
     * `allocatePayment` would re-derive the same numbers from state this
     * function has just written, which is a longer way to be wrong.
     */
    await accounting.postIfAbsent(
      loanPaymentEntry({
        loanId,
        loanNumber: loan.number,
        paymentId: payment.id,
        amount: row.totalDue,
        interestPortion: row.interestDue,
        principalPortion: row.principalDue,
        paidOn: row.dueDate,
      }),
      { postedById: officerId },
    );
  }

  /*
   * Bad Debt on the written-off loan. Nothing was ever paid on it, so
   * the whole principal goes — mirroring `LoanRepository.writeOff`.
   * Without this the receivable stays on the books for a loan the
   * lender has given up on, which is the single figure a write-off
   * exists to correct.
   */
  if (status === "WRITTEN_OFF") {
    const writtenOffAt = addMonths(now, -1);
    await accounting.postIfAbsent(
      buildEntry({
        entryDate: writtenOffAt,
        source: "MANUAL",
        sourceRefType: "LoanWriteOff",
        sourceRefId: loanId,
        memo: `Write-off ${loan.number}: Fixture: uncollectible after default`,
        lines: [
          {
            accountCode: ACCOUNT_CODES.BAD_DEBT_EXPENSE,
            debit: PRINCIPAL,
            credit: 0,
          },
          {
            accountCode: ACCOUNT_CODES.LOANS_RECEIVABLE,
            debit: 0,
            credit: PRINCIPAL,
          },
        ],
      }),
      { postedById: officerId },
    );
  }

  const lastDue = dueDateOf(rows.length);
  await prisma.loanApplication.update({
    where: { id: loanId },
    data: {
      disbursedAt,
      disbursedById: officerId,
      decidedAt: disbursedAt,
      decidedById: officerId,
      ...(status === "CLOSED" ? { closedAt: lastDue } : {}),
      ...(status === "WRITTEN_OFF"
        ? {
            // Nothing was ever paid on this one, so the whole principal
            // went to Bad Debt — posted above.
            writeOffAmount: PRINCIPAL,
            writeOffReason: "Fixture: uncollectible after default",
            writtenOffAt: addMonths(now, -1),
            writtenOffById: officerId,
          }
        : {}),
    },
  });
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
