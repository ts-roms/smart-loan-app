import type { FastifyInstance } from "fastify";
import {
  JobRepository,
  NotificationRepository,
  type PrismaClient,
  ScreeningRepository,
  TenantScheduler,
} from "@loan/db";

import { config } from "../config";
import { TenantAwareNotificationProvider } from "../features/system/notification-providers";
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
import { complianceRoutes } from "../features/compliance/index";
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
import { licensingRoutes } from "../features/licensing/index";
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
  // Providers are singletons (env-driven, see config.ts + providers.ts).
  // The repos that consume them, however, are tenant-scoped: each
  // request gets a NotificationRepository / ScreeningRepository bound
  // to the calling tenant's Prisma client so we never read or write
  // the wrong schema. The factories below are exposed on `app` and
  // consumed by per-request preHandlers throughout the features tree.
  const notificationProvider = createNotificationProvider(
    config.notificationProvider,
    app.log,
  );
  const buildAmlProvider = (prisma: PrismaClient) =>
    createAmlProvider(
      config.amlProvider,
      async () => {
        // Each tenant has its own watchlist seed; the provider closes
        // over the tenant's prisma so the loader hits the right schema.
        const rows = await prisma.amlWatchlistEntry.findMany();
        return rows.map((r) => ({
          list: r.list,
          fullName: r.fullName,
          aliases: r.aliases,
          reason: r.reason,
        }));
      },
      app.log,
    );

  // Factory decorators. Callers invoke as `app.notifications(prisma)` /
  // `app.screening(prisma)` from a per-request preHandler with
  // `req.tenantCtx.prisma`.
  //
  // The notifications factory wraps the platform-shared provider in a
  // `TenantAwareNotificationProvider` that reads `SystemConfig` on
  // each dispatch — when a tenant has their own Twilio/SendGrid
  // creds, the right channel routes through their provider instead.
  // See features/system/notification-providers.ts for the resolution
  // logic.
  app.decorate(
    "notifications",
    (prisma: PrismaClient) =>
      new NotificationRepository(
        prisma,
        new TenantAwareNotificationProvider(prisma, notificationProvider),
      ),
  );
  app.decorate(
    "screening",
    (prisma: PrismaClient) =>
      new ScreeningRepository(prisma, buildAmlProvider(prisma)),
  );

  // Per-tenant job scheduler. One interval at the platform level fans
  // out across every ACTIVE tenant on each tick (single-tenant mode
  // short-circuits to the default slug). The factory rebuilds the job
  // definitions with each tenant's prisma so notification dispatches
  // + screening runs land in the right schema.
  //
  // We keep the legacy `app.jobs` shape — the /jobs admin routes still
  // need a JobRepository handle and the registered defs — but we point
  // them at a builder bound to `app.prisma`. In single-tenant mode that
  // matches the scheduler's view exactly. In multi-tenant mode the
  // admin routes have to be invoked from a tenant context anyway
  // (they're per-request, sit behind resolveTenant); the platform-bound
  // jobRepo here is purely for the legacy job definitions reference.
  const buildJobsForPrisma = (prisma: PrismaClient) =>
    buildJobDefinitions(
      prisma,
      new NotificationRepository(prisma, notificationProvider),
      new ScreeningRepository(prisma, buildAmlProvider(prisma)),
    );

  const scheduler = new TenantScheduler({
    platformPrisma: app.prisma,
    tenantCache: app.tenantPrisma,
    multiTenant: config.multiTenant,
    defaultSlug: "default",
    buildJobDefinitions: buildJobsForPrisma,
    log: app.log,
  });
  scheduler.start();
  app.addHook("onClose", async () => scheduler.stop());

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
  await app.register(
    jobRoutes((req) => {
      const prisma = req.tenantCtx.prisma;
      return {
        repo: new JobRepository(prisma),
        defs: buildJobsForPrisma(prisma),
      };
    }),
    { prefix: "/jobs" },
  );
  await app.register(notificationRoutes, { prefix: "/notifications" });
  await app.register(screeningRoutes, { prefix: "/screening" });
  await app.register(decisionRuleRoutes, { prefix: "/decision-rules" });
  // PDF documents: officer view + customer-scoped portal mirror.
  await app.register(documentRoutes);
  await app.register(portalDocumentRoutes, { prefix: "/portal" });
  await app.register(rbacRoutes, { prefix: "/admin" });
  // GDPR / PH Data Privacy Act §16(c)+(e). Mounted under /compliance
  // (sibling to /admin) so the DSAR responder doesn't need admin.users
  // — the permission is gated separately as admin.compliance.
  await app.register(complianceRoutes, { prefix: "/compliance" });
  await app.register(delegationRoutes, { prefix: "/delegations" });
  await app.register(reconciliationRoutes, { prefix: "/reconciliation" });
  await app.register(eclRoutes, { prefix: "/ecl" });
  await app.register(cooperativeRoutes, { prefix: "/cooperative" });
  await app.register(auditRoutes, { prefix: "/audit" });
  // Annual / renewable docs — split into per-loan (mounted on
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
  // (Platform console + public/marketing endpoints are registered
  // OUTSIDE /api/v1 directly in app.ts — they're not part of the
  // tenant API contract.)
  // Approval-chain routes mount under their natural parents so URLs read
  // /loans/:idOrNumber/approvals and /loan-products/:code/approval-chain.
  await app.register(loanApprovalRoutes, { prefix: "/loans" });
  await app.register(loanApprovalChainRoutes, { prefix: "/loan-products" });
}

// Augment FastifyInstance to make the per-tenant repo factories
// visible. Each factory takes a PrismaClient (the caller's
// `req.tenantCtx.prisma`) and returns a fresh repo bound to that
// schema.
declare module "fastify" {
  interface FastifyInstance {
    notifications: (prisma: PrismaClient) => NotificationRepository;
    screening: (prisma: PrismaClient) => ScreeningRepository;
  }
}
