/**
 * Top up the scratch database's fixtures for the write journey.
 *
 * `docs/smoke-tests/fixtures.ts` gives us customers to lend to, but it
 * sets `Customer.kycStatus` without creating any KycSubmission rows —
 * and both the wizard's step-2 gate (KycGapWarning) and the API's
 * decide-time `validateKyc` judge the SUBMISSIONS, not the customer
 * flag. Without these rows the journey's borrower can never leave the
 * Product & Terms step honestly.
 *
 * So: three VERIFIED submissions — the base pack @loan/kyc requires
 * (ID_FRONT, PROOF_OF_INCOME, PROOF_OF_ADDRESS) — for the journey's
 * borrower, PICKER-001 "Clara Clean". The SALARY product adds no
 * product-specific docs, so this is the complete set.
 *
 * Upserts keyed on the unique `number`, so re-running against the same
 * database (which the disposable-DB design makes rare but not
 * impossible) changes nothing.
 *
 * Run with tsx from `libs/db`, DATABASE_URL pointing at the SCRATCH
 * database. Never run against dev — though if you did, the damage is
 * three obviously-labelled E2E-KYC rows, not a drifted ledger.
 *
 * `.mjs` under `scripts/` for the boundary reason set out at length in
 * `db-admin.mjs`.
 */
import { createPrismaClient } from "../../../../../libs/db/src/client.ts";

const BASE_PACK = ["ID_FRONT", "PROOF_OF_INCOME", "PROOF_OF_ADDRESS"];

async function main() {
  const prisma = createPrismaClient(process.env.DATABASE_URL);
  try {
    const customer = await prisma.customer.findFirstOrThrow({
      where: { number: "PICKER-001" },
    });
    const officer = await prisma.user.findFirstOrThrow({
      where: { role: "LOAN_OFFICER" },
    });
    for (let i = 0; i < BASE_PACK.length; i++) {
      const documentType = BASE_PACK[i];
      const number = `E2E-KYC-${String(i + 1).padStart(4, "0")}`;
      await prisma.kycSubmission.upsert({
        where: { number },
        create: {
          number,
          customerId: customer.id,
          documentType,
          documentUrl: `/uploads/kyc/e2e-write-journey-${documentType.toLowerCase()}.jpg`,
          status: "VERIFIED",
          notes: "Write-journey fixture — verified base pack",
          submittedById: officer.id,
          decidedById: officer.id,
          decidedAt: new Date(),
        },
        update: {},
      });
    }
    console.log(
      `verified base KYC pack for ${customer.number} (${customer.firstName} ${customer.lastName})`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
