import type { FastifyInstance } from "fastify";
import {
  JobRepository,
  NotificationRepository,
  ScreeningRepository,
} from "@loan/db";

import { config } from "../config.js";
import { createAmlProvider, createNotificationProvider } from "../providers.js";

import { accountingRoutes } from "./accounting.js";
import { authRoutes } from "./auth.js";
import { collectionsRoutes } from "./collections.js";
import { customerRoutes } from "./customers.js";
import { healthRoutes } from "./health.js";
import { kycRoutes } from "./kyc.js";
import { loanProductRoutes } from "./loan-products.js";
import { loanRoutes } from "./loans.js";
import { paymentsRoutes } from "./payments.js";
import { portalRoutes } from "./portal.js";
import { scoringRoutes } from "./scoring.js";
import { uploadRoutes } from "./uploads.js";
import { jobRoutes } from "./jobs.js";
import { notificationRoutes } from "./notifications.js";
import { screeningRoutes } from "./screening.js";
import { decisionRuleRoutes } from "./decision-rules.js";
import { delegationRoutes } from "./delegations.js";
import { cooperativeRoutes } from "./cooperative.js";
import { eclRoutes } from "./ecl.js";
import { reconciliationRoutes } from "./reconciliation.js";
import { documentRoutes, portalDocumentRoutes } from "./documents.js";
import { rbacRoutes } from "./rbac.js";
import { auditRoutes } from "./audit.js";
import { annualDocsLoanRoutes, annualDocsRoutes } from "./annual-docs.js";
import { demandLetterRoutes } from "./demand-letters.js";
import { repossessionRoutes } from "./repossession.js";
import { dorsiRoutes } from "./dorsi.js";
import { leaseRoutes } from "./lease.js";
import { reportRoutes } from "./reports.js";
import { assistantRoutes } from "./assistant.js";
import { systemRoutes } from "./system.js";
import {
  loanApprovalRoutes,
  loanApprovalChainRoutes,
} from "./loan-approvals.js";

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
