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
 * Re-runnable: every PICKER-* row is deleted and recreated, so the smoke
 * test starts from a known state on each run. That matters because the
 * payments section of the smoke test settles a payment, and these fixture
 * loans deliberately have no LoanSchedule rows — `recordPayment` closes a
 * loan once no open installment remains, so a settled payment flips
 * whichever loan it touched from ACTIVE to CLOSED. Without the reset the
 * picker assertions pass once and fail on every run after.
 *
 * DEV ONLY. Points at whatever DATABASE_URL resolves to, and deletes rows.
 * Never run against anything you care about.
 *
 *   pnpm --filter @loan/db exec dotenv -e ../../.env -- tsx ../../docs/smoke-tests/fixtures.ts
 */
import { PrismaClient, type LoanStatus } from "@prisma/client";

const prisma = new PrismaClient();

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
      await prisma.loanApplication.create({
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
    }
    console.log(`${customer.number} ${fullName} → [${statuses.join(", ")}]`);
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
