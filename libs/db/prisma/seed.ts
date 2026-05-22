/**
 * Seed — a minimal set of users + the default chart of accounts so the API
 * boots with something to log in as and journal entries can be posted.
 * Run with `pnpm db:seed`.
 */
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "@loan/auth";
import { AccountingRepository } from "../src/repositories/accounting.repository";
import { LoanProductRepository } from "../src/repositories/loan-product.repository";
import { DecisionRuleRepository } from "../src/repositories/decision-rule.repository";
import {
  PermissionRepository,
  RoleRepository,
} from "../src/repositories/rbac.repository";

const prisma = new PrismaClient();

async function main() {
  const admin = await prisma.user.upsert({
    where: { email: "admin@loan.local" },
    create: {
      email: "admin@loan.local",
      name: "Admin",
      role: "ADMIN",
      passwordHash: await hashPassword("P@ssw0rd123"),
    },
    update: {},
  });
  const officer = await prisma.user.upsert({
    where: { email: "officer@loan.local" },
    create: {
      email: "officer@loan.local",
      name: "Loan Officer",
      role: "LOAN_OFFICER",
      passwordHash: await hashPassword("P@ssw0rd123"),
    },
    update: {},
  });
  const accountant = await prisma.user.upsert({
    where: { email: "accountant@loan.local" },
    create: {
      email: "accountant@loan.local",
      name: "Accountant",
      role: "ACCOUNTANT",
      passwordHash: await hashPassword("P@ssw0rd123"),
    },
    update: {},
  });

  // Default chart of accounts — idempotent.
  const accounting = new AccountingRepository(prisma);
  const chart = await accounting.seedDefaultChart();

  // Default loan products — idempotent.
  const productRepo = new LoanProductRepository(prisma);
  const products = await productRepo.seedDefaults();

  // Default decision rules — idempotent.
  const ruleRepo = new DecisionRuleRepository(prisma);
  const rules = await ruleRepo.seedDefaults();

  // RBAC: permission catalog + canonical roles + backfill assignments
  // for the seeded users.
  const permRepo = new PermissionRepository(prisma);
  const perms = await permRepo.seed();
  const roleRepo = new RoleRepository(prisma);
  const roleResult = await roleRepo.seedDefaults();
  const backfill = await roleRepo.backfillFromUserRoleEnum();

  console.log("Seeded users:");
  console.log(`  ${admin.email}      / P@ssw0rd123  (${admin.role})`);
  console.log(`  ${officer.email}    / P@ssw0rd123  (${officer.role})`);
  console.log(`  ${accountant.email} / P@ssw0rd123  (${accountant.role})`);
  console.log(
    `Chart of accounts: ${chart.created} created, ${chart.existing} already present.`,
  );
  console.log(
    `Loan products:     ${products.created} created, ${products.existing} already present.`,
  );
  console.log(
    `Decision rules:    ${rules.created} created, ${rules.existing} already present.`,
  );
  console.log(
    `Permissions:       ${perms.created} created, ${perms.existing} already present.`,
  );
  console.log(
    `Roles:             ${roleResult.created} created, ${roleResult.existing} reconciled.`,
  );
  console.log(
    `Role assignments:  ${backfill.assigned} backfilled from User.role.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
