import { randomBytes } from "node:crypto";

import { hashPassword } from "@loan/auth";
import type { PrismaClient } from "@prisma/client";

import { AccountingRepository } from "../repositories/accounting.repository";
import { DecisionRuleRepository } from "../repositories/decision-rule.repository";
import { LoanProductRepository } from "../repositories/loan-product.repository";
import {
  PermissionRepository,
  RoleRepository,
} from "../repositories/rbac.repository";

/**
 * Provision the canonical content of a fresh tenant schema.
 *
 * Called by `PlatformService.provisionTenant` after schema creation +
 * `prisma migrate deploy`. Runs against the tenant-scoped Prisma
 * client (NOT the control-plane client) so every row lands in
 * `tenant_<slug>`, not `public`.
 *
 * What gets seeded:
 *
 *   - Permission catalog (`PermissionRepository.seed()`)
 *   - Default Role rows with their permission grants
 *     (`RoleRepository.seedDefaults()`)
 *   - Default chart of accounts (`AccountingRepository.seedDefaultChart()`)
 *   - Default LoanProduct templates (`LoanProductRepository.seedDefaults()`)
 *   - Default DecisionRule catalogue (`DecisionRuleRepository.seedDefaults()`)
 *   - Bootstrap admin User with a generated random password
 *
 * The password is returned ONCE — the platform service surfaces it to
 * the vendor staff who provisioned the tenant, who hand it off to the
 * cooperative's admin. We don't store the plaintext anywhere; the
 * hash is what's persisted.
 *
 * Idempotent: re-running the seed (e.g. P2.2's retry button) skips
 * the user creation if a bootstrap admin already exists, and the
 * repo-layer seeds are themselves idempotent. The returned
 * `generatedPassword` is null on a re-run since we never re-issue
 * for an existing user.
 */

export interface SeedTenantArgs {
  /** Tenant-scoped Prisma client (bound to `tenant_<slug>`). */
  prisma: PrismaClient;
  /** Email for the bootstrap admin user. */
  adminEmail: string;
  /** Display name for the admin user. */
  adminName?: string;
  /**
   * Explicit password override. Mainly for tests; production callers
   * leave this undefined and let the helper generate one.
   */
  adminPassword?: string;
}

export interface SeedTenantResult {
  /**
   * The bootstrap admin's plaintext password. Returned ONCE on first
   * provisioning; null on subsequent runs (existing user → no rotation).
   * Treat this as sensitive — hand it to the cooperative admin
   * immediately and don't log it.
   */
  generatedPassword: string | null;
  /** Summary counts for the operator's audit trail. */
  summary: {
    permissionsCreated: number;
    rolesCreated: number;
    accountsCreated: number;
    productsCreated: number;
    decisionRulesCreated: number;
    adminCreated: boolean;
  };
}

export async function seedTenant(
  args: SeedTenantArgs,
): Promise<SeedTenantResult> {
  const { prisma } = args;

  // RBAC catalog first — roles will reference permissions, and we
  // want to assign the ADMIN role to the bootstrap user below.
  const perms = await new PermissionRepository(prisma).seed();
  const roles = await new RoleRepository(prisma).seedDefaults();

  // Reference data that the API expects to exist.
  const chart = await new AccountingRepository(prisma).seedDefaultChart();
  const products = await new LoanProductRepository(prisma).seedDefaults();
  const rules = await new DecisionRuleRepository(prisma).seedDefaults();

  // Bootstrap admin — skip if one already exists at this email
  // (re-provisioning retry, manual seed, etc.). We don't pick a
  // different email to dodge the conflict; if the cooperative's admin
  // changed their email already, the seed retry shouldn't undo that.
  const existing = await prisma.user.findUnique({
    where: { email: args.adminEmail },
  });

  let generatedPassword: string | null = null;
  let adminCreated = false;

  if (!existing) {
    const password = args.adminPassword ?? generateInitialPassword();
    await prisma.user.create({
      data: {
        email: args.adminEmail,
        name: args.adminName ?? "Cooperative Admin",
        role: "ADMIN",
        passwordHash: await hashPassword(password),
      },
    });
    // backfillFromUserRoleEnum assigns the seeded ADMIN role to the
    // new user so the RBAC permission check works on first login.
    await new RoleRepository(prisma).backfillFromUserRoleEnum();
    generatedPassword = password;
    adminCreated = true;
  }

  return {
    generatedPassword,
    summary: {
      permissionsCreated: perms.created,
      rolesCreated: roles.created,
      accountsCreated: chart.created,
      productsCreated: products.created,
      decisionRulesCreated: rules.created,
      adminCreated,
    },
  };
}

/**
 * Generate a high-entropy initial password. The cooperative admin
 * is expected to change this on first login, but we shouldn't leak
 * obvious-looking strings if the email transit is intercepted.
 *
 * 16 base64url chars from 12 bytes of crypto-random → ~72 bits.
 * No special chars to avoid quoting headaches when the admin pastes
 * it from the email into the login form.
 */
function generateInitialPassword(): string {
  return randomBytes(12).toString("base64url").slice(0, 16);
}
