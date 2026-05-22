/**
 * Per-request branding lookup.
 *
 * Used by every PDF route + a few notification touchpoints to source
 * the live company name/contact details from SystemConfig. The
 * SystemConfig row is a singleton so the lookup is a single primary-
 * key read — Prisma + Postgres handle that in microseconds.
 *
 * Env vars (COMPANY_NAME) stay as boot-time defaults so a brand-new
 * install renders cleanly before any admin has visited /settings.
 */

import type { PrismaClient } from "@loan/db";

export interface BrandingSnapshot {
  companyName: string;
  companyLogoUrl: string | null;
  companyTagline: string | null;
  companyAddress: string | null;
  companyPhone: string | null;
  companyEmail: string | null;
  companyWebsite: string | null;
}

const ENV_DEFAULT_NAME = process.env.COMPANY_NAME ?? "SmartLoan";

/**
 * Read the live branding. Upserts the singleton row on first call so
 * fresh installs return defaults rather than null.
 */
export async function getBranding(
  prisma: PrismaClient,
): Promise<BrandingSnapshot> {
  const cfg = await prisma.systemConfig.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton", companyName: ENV_DEFAULT_NAME },
    select: {
      companyName: true,
      companyLogoUrl: true,
      companyTagline: true,
      companyAddress: true,
      companyPhone: true,
      companyEmail: true,
      companyWebsite: true,
    },
  });
  return cfg;
}
