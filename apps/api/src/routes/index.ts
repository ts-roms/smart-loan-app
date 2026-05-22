import type { FastifyInstance } from "fastify";
import {
  JobRepository,
  NotificationRepository,
  ScreeningRepository,
} from "@loan/db";

import { config } from "../config";
import { createAmlProvider, createNotificationProvider } from "../providers";

// Every route plugin lives under apps/api/src/features/<feature>/ now.
// Alphabetised for readability; the registrar at the bottom mounts each
// at its URL prefix (the prefix is the source of truth for path, not
// the import order here).
import { accountingRoutes } from "../features/accounting/index";
import {
  annualDocsLoanRoutes,
  annualDocsRoutes,
} from "../features/annual-docs/index";
import { assistantRoutes } from "../features/assistant/index";
import { auditRoutes } from "../features/audit/index";
import { authRoutes } from "../features/auth/index";
import { collectionsRoutes } from "../features/collections/index";
import { cooperativeRoutes } from "../features/cooperative/index";
import { customerRoutes } from "../features/customers/index";
import { decisionRuleRoutes } from "../features/decision-rules/index";
import { delegationRoutes } from "../features/delegations/index";
import { demandLetterRoutes } from "../features/demand-letters/index";
import {
  documentRoutes,
  portalDocumentRoutes,
} from "../features/documents/index";
import { dorsiRoutes } from "../features/dorsi/index";
import { eclRoutes } from "../features/ecl/index";
import { healthRoutes } from "../features/health/index";
import { jobRoutes } from "../features/jobs/index";
import { kycRoutes } from "../features/kyc/index";
import { leaseRoutes } from "../features/lease/index";
import {
  licensingRoutes,
  type LicensingService,
} from "../features/licensing/index";
import { platformRoutes } from "../features/platform/index";
import {
  loanProductRoutes,
  loanApprovalChainRoutes,
} from "../features/loan-products/index";
import { loanRoutes, loanApprovalRoutes } from "../features/loans/index";
import { notificationRoutes } from "../features/notifications/index";
import { paymentsRoutes } from "../features/payments/index";
import { portalRoutes } from "../features/portal/index";
import { rbacRoutes } from "../features/rbac/index";
import { reconciliationRoutes } from "../features/reconciliation/index";
import { reportRoutes } from "../features/reports/index";
import { repossessionRoutes } from "../features/repossession/index";
import { scoringRoutes } from "../features/scoring/index";
import { screeningRoutes } from "../features/screening/index";
import { systemRoutes } from "../features/system/index";
import { uploadRoutes } from "../features/uploads/index";

import { buildJobDefinitions } from "../jobs";

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  // Single instances of the cross-cutting repos so the routes + scheduler
  // share state. The screening provider reads the watchlist via the repo's
  // loader, so the seed-watchlist endpoint immediately affects screens.
  // Providers are env-driven (see config.ts + providers.ts). Falls back
  // to MOCK in dev / when real credentials aren't set.
  const amlProvider = createAmlProvider(
    config.amlProvider,
    async () => {
      const rows = await app.prisma.amlWatchlistEntry.findMany();
      return rows.map((r) => ({
        list: r.list,
        fullName: r.fullName,
        aliases: r.aliases,
        reason: r.reason,
      }));
    },
    app.log,
  );
  const screeningRepo: ScreeningRepository = new ScreeningRepository(
    app.prisma,
    amlProvider,
  );
  const notificationRepo = new NotificationRepository(
    app.prisma,
    createNotificationProvider(config.notificationProvider, app.log),
  );
  const jobRepo = new JobRepository(app.prisma);
  const jobDefs = buildJobDefinitions(
    app.prisma,
    notificationRepo,
    screeningRepo,
  );
  await jobRepo.register(jobDefs);
  jobRepo.start(jobDefs);
  app.addHook("onClose", async () => jobRepo.stop());

  // Expose the repos so other route plugins can use them later.
  app.decorate("notifications", notificationRepo);
  app.decorate("screening", screeningRepo);

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: "/auth" });
  await app.register(customerRoutes, { prefix: "/customers" });
  await app.register(kycRoutes, { prefix: "/kyc" });
  await app.register(scoringRoutes, { prefix: "/scoring" });
  await app.register(loanRoutes, { prefix: "/loans" });
  await app.register(loanProductRoutes, { prefix: "/loan-products" });
  await app.register(accountingRoutes, { prefix: "/accounting" });
  await app.register(collectionsRoutes, { prefix: "/collections" });
  await app.register(paymentsRoutes, { prefix: "/payments" });
  await app.register(portalRoutes, { prefix: "/portal" });
  await app.register(uploadRoutes, { prefix: "/uploads-api" });
  await app.register(jobRoutes(jobRepo, jobDefs), { prefix: "/jobs" });
  await app.register(notificationRoutes(notificationRepo), {
    prefix: "/notifications",
  });
  await app.register(screeningRoutes(screeningRepo), { prefix: "/screening" });
  await app.register(decisionRuleRoutes, { prefix: "/decision-rules" });
  // PDF documents: officer view + customer-scoped portal mirror.
  await app.register(documentRoutes);
  await app.register(portalDocumentRoutes, { prefix: "/portal" });
  await app.register(rbacRoutes, { prefix: "/admin" });
  await app.register(delegationRoutes, { prefix: "/delegations" });
  await app.register(reconciliationRoutes, { prefix: "/reconciliation" });
  await app.register(eclRoutes, { prefix: "/ecl" });
  await app.register(cooperativeRoutes, { prefix: "/cooperative" });
  await app.register(auditRoutes, { prefix: "/audit" });
  // Annual / renewable docs (FRD §3.8) — split into per-loan (mounted on
  // /loans/:loanId/annual-docs) and cross-loan (/annual-docs/*) surfaces.
  await app.register(annualDocsLoanRoutes, { prefix: "/loans" });
  await app.register(annualDocsRoutes, { prefix: "/annual-docs" });
  await app.register(demandLetterRoutes, { prefix: "/demand-letters" });
  await app.register(repossessionRoutes, { prefix: "/repossession" });
  await app.register(dorsiRoutes, { prefix: "/dorsi" });
  await app.register(leaseRoutes, { prefix: "/lease" });
  await app.register(reportRoutes, { prefix: "/reports" });
  await app.register(assistantRoutes, { prefix: "/assistant" });
  await app.register(systemRoutes, { prefix: "/system" });
  // License activation / status. Mounted under /license so the
  // mutating endpoints (admin.roles-gated) cluster naturally.
  await app.register(licensingRoutes, { prefix: "/license" });
  // Platform console — vendor control plane. Shares the same Fastify
  // instance + JWT secret but uses a distinct `platform: true` claim,
  // a distinct PlatformUser table, and a distinct audit log. Tenant
  // and platform tokens are non-interchangeable: tenant routes reject
  // platform tokens (via fail-close permission resolution), platform
  // routes reject tenant tokens (via the platform: true check).
  await app.register(platformRoutes, { prefix: "/platform" });
  // Approval-chain routes mount under their natural parents so URLs read
  // /loans/:idOrNumber/approvals and /loan-products/:code/approval-chain.
  await app.register(loanApprovalRoutes, { prefix: "/loans" });
  await app.register(loanApprovalChainRoutes, { prefix: "/loan-products" });
}

// Augment FastifyInstance to make the decorated repos visible.
declare module "fastify" {
  interface FastifyInstance {
    notifications: NotificationRepository;
    screening: ScreeningRepository;
    /**
     * Licensing service decorator. Set by `licensingRoutes` on
     * register; consumed in Phase 1b by `app.requireFeature(...)`
     * (and in the meantime by anyone who wants to check the
     * current license programmatically).
     */
    license: LicensingService;
  }
}
