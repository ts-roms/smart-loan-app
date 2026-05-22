import type { FastifyInstance } from "fastify";
import {
  JobRepository,
  NotificationRepository,
  ScreeningRepository,
} from "@loan/db";

import { config } from "../config.js";
import { createAmlProvider, createNotificationProvider } from "../providers.js";

// Every route plugin lives under apps/api/src/features/<feature>/ now.
// Alphabetised for readability; the registrar at the bottom mounts each
// at its URL prefix (the prefix is the source of truth for path, not
// the import order here).
import { accountingRoutes } from "../features/accounting/index.js";
import {
  annualDocsLoanRoutes,
  annualDocsRoutes,
} from "../features/annual-docs/index.js";
import { assistantRoutes } from "../features/assistant/index.js";
import { auditRoutes } from "../features/audit/index.js";
import { authRoutes } from "../features/auth/index.js";
import { collectionsRoutes } from "../features/collections/index.js";
import { cooperativeRoutes } from "../features/cooperative/index.js";
import { customerRoutes } from "../features/customers/index.js";
import { decisionRuleRoutes } from "../features/decision-rules/index.js";
import { delegationRoutes } from "../features/delegations/index.js";
import { demandLetterRoutes } from "../features/demand-letters/index.js";
import {
  documentRoutes,
  portalDocumentRoutes,
} from "../features/documents/index.js";
import { dorsiRoutes } from "../features/dorsi/index.js";
import { eclRoutes } from "../features/ecl/index.js";
import { healthRoutes } from "../features/health/index.js";
import { jobRoutes } from "../features/jobs/index.js";
import { kycRoutes } from "../features/kyc/index.js";
import { leaseRoutes } from "../features/lease/index.js";
import {
  loanProductRoutes,
  loanApprovalChainRoutes,
} from "../features/loan-products/index.js";
import { loanRoutes, loanApprovalRoutes } from "../features/loans/index.js";
import { notificationRoutes } from "../features/notifications/index.js";
import { paymentsRoutes } from "../features/payments/index.js";
import { portalRoutes } from "../features/portal/index.js";
import { rbacRoutes } from "../features/rbac/index.js";
import { reconciliationRoutes } from "../features/reconciliation/index.js";
import { reportRoutes } from "../features/reports/index.js";
import { repossessionRoutes } from "../features/repossession/index.js";
import { scoringRoutes } from "../features/scoring/index.js";
import { screeningRoutes } from "../features/screening/index.js";
import { systemRoutes } from "../features/system/index.js";
import { uploadRoutes } from "../features/uploads/index.js";

import { buildJobDefinitions } from "../jobs.js";

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
  }
}
