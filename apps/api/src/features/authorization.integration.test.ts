/**
 * Authorization gating — integration tests over the real route plugins.
 *
 * ## What this covers, and why it looks like this
 *
 * The bug these tests exist to prevent: a route group registers
 * `app.authenticate` + `app.resolveTenant` and stops there, so *any*
 * authenticated account reaches it. A CUSTOMER portal login (whose only
 * permission is `portal.self`) could read every customer's PII, pull
 * other borrowers' signed agreements, edit `monthlyIncome` — which
 * feeds credit scoring — and post payments straight into the general
 * ledger. Unit-testing a controller can't catch that; the defect lives
 * in the *wiring*, so the test has to exercise the wiring.
 *
 * So this boots a real Fastify instance, registers the real
 * `fastifyAuth` plugin (real `requirePermission`, real `authenticate`,
 * real JWT verification) and the real feature route plugins at their
 * production prefixes. Only the infrastructure below the routes is
 * stubbed: Prisma, the notification/screening factories, and the
 * license feature gate. Nothing about the authorization path is faked.
 *
 * Consequence worth knowing when reading failures: when a request DOES
 * clear the gate, the handler runs against the stub Prisma and usually
 * 500s. That's expected. The positive assertions are therefore
 * `not.toBe(403)` — "the gate let this role through" — not `toBe(200)`.
 * Asserting handler success would require a fake ORM and would test
 * something else entirely.
 */

import { DEFAULT_ROLE_BY_KEY, fastifyAuth } from "@loan/auth";
import Fastify, { type FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { accountingRoutes } from "./accounting/index";
import { auditRoutes } from "./audit/index";
import { collectionsRoutes } from "./collections/index";
import { customerRoutes } from "./customers/index";
import { decisionRuleRoutes } from "./decision-rules/index";
import { delegationRoutes } from "./delegations/index";
import { documentRoutes } from "./documents/index";
import { kycRoutes } from "./kyc/index";
import { loanRoutes } from "./loans/index";
import { notificationRoutes } from "./notifications/index";
import { paymentsRoutes } from "./payments/index";
import { preAssessmentRoutes } from "./pre-assessment/index";
import { rbacRoutes } from "./rbac/index";
import { scoringRoutes } from "./scoring/index";
import { screeningRoutes } from "./screening/index";

const JWT_SECRET = "test-secret-not-used-anywhere-real";

/** Permission sets straight from the canonical role catalog. */
const PERMS = {
  CUSTOMER: new Set(DEFAULT_ROLE_BY_KEY.CUSTOMER!.permissions),
  LOAN_OFFICER: new Set(DEFAULT_ROLE_BY_KEY.LOAN_OFFICER!.permissions),
  ACCOUNTANT: new Set(DEFAULT_ROLE_BY_KEY.ACCOUNTANT!.permissions),
  ADMIN: new Set(DEFAULT_ROLE_BY_KEY.ADMIN!.permissions),
};

/**
 * The whole point of the CUSTOMER role: one permission, self-service
 * only. If this ever grows, the expectations below stop meaning what
 * they say — so assert it up front.
 */
describe("CUSTOMER role catalog", () => {
  it("grants portal.self and nothing else", () => {
    expect([...PERMS.CUSTOMER]).toEqual(["portal.self"]);
  });
});

// ─── harness ─────────────────────────────────────────────────────────

interface StubPrisma {
  /** Marker so we can assert WHICH client the resolver was handed. */
  __label: string;
  user: { findUnique: ReturnType<typeof vi.fn> };
  loanApplication: { findFirst: ReturnType<typeof vi.fn> };
}

function makeStubPrisma(label: string): StubPrisma {
  return {
    __label: label,
    user: { findUnique: vi.fn(async () => null) },
    loanApplication: { findFirst: vi.fn(async () => null) },
  };
}

interface Harness {
  app: FastifyInstance;
  tenantPrisma: StubPrisma;
  platformPrisma: StubPrisma;
  /** Records every (userId, prismaHandedToResolver) pair. */
  resolverCalls: Array<{ userId: string; prismaLabel: string | undefined }>;
  token: (role: keyof typeof PERMS, sub?: string) => string;
  platformToken: () => string;
}

async function buildHarness(): Promise<Harness> {
  const app = Fastify({ logger: false });
  const platformPrisma = makeStubPrisma("platform/public");
  const tenantPrisma = makeStubPrisma("tenant");
  const resolverCalls: Harness["resolverCalls"] = [];

  // Role is carried on the JWT so the resolver can answer without a DB.
  // In production this is `resolveEffectivePermissions` against the
  // tenant schema; here we assert the client it's handed and return the
  // canonical set for the caller's role.
  const permsByUser = new Map<string, Set<string>>();

  app.decorate("prisma", platformPrisma as never);
  app.decorate("tenantPrisma", { get: () => tenantPrisma } as never);

  await app.register(fastifyAuth, {
    secret: JWT_SECRET,
    resolvePermissions: async (userId: string, prisma?: unknown) => {
      resolverCalls.push({
        userId,
        prismaLabel: (prisma as StubPrisma | undefined)?.__label,
      });
      return permsByUser.get(userId) ?? new Set<string>();
    },
  });

  // Single-tenant `resolveTenant` semantics, but pointing at a
  // *distinguishable* client so we can prove `requirePermission`
  // resolves against the tenant schema rather than the public one.
  const resolveTenant = async (req: { tenantCtx?: unknown }) => {
    req.tenantCtx = { slug: "default", prisma: tenantPrisma };
  };
  app.decorate("resolveTenant", resolveTenant as never);

  // Infrastructure the feature plugins build per request. None of it
  // participates in authorization.
  app.decorate("notifications", () => ({}) as never);
  app.decorate("screening", () => ({}) as never);
  app.decorate("requireFeature", () => async () => {});

  await app.register(customerRoutes, { prefix: "/api/v1/customers" });
  await app.register(loanRoutes, { prefix: "/api/v1/loans" });
  await app.register(accountingRoutes, { prefix: "/api/v1/accounting" });
  await app.register(kycRoutes, { prefix: "/api/v1/kyc" });
  await app.register(collectionsRoutes, { prefix: "/api/v1/collections" });
  await app.register(screeningRoutes, { prefix: "/api/v1/screening" });
  await app.register(notificationRoutes, { prefix: "/api/v1/notifications" });
  await app.register(scoringRoutes, { prefix: "/api/v1/scoring" });
  await app.register(decisionRuleRoutes, { prefix: "/api/v1/decision-rules" });
  await app.register(preAssessmentRoutes, {
    prefix: "/api/v1/pre-assessments",
  });
  await app.register(delegationRoutes, { prefix: "/api/v1/delegations" });
  await app.register(paymentsRoutes, { prefix: "/api/v1/payments" });
  await app.register(rbacRoutes, { prefix: "/api/v1/admin" });
  await app.register(auditRoutes, { prefix: "/api/v1/audit" });
  // Officer document surface mounts at the API root in production.
  await app.register(documentRoutes, { prefix: "/api/v1" });

  await app.ready();

  let seq = 0;
  const token = (role: keyof typeof PERMS, sub?: string) => {
    const id = sub ?? `user-${role}-${++seq}`;
    permsByUser.set(id, PERMS[role]);
    return app.jwt.sign({
      sub: id,
      email: `${id}@example.test`,
      role: role === "ADMIN" ? "ADMIN" : role,
      tenant: "default",
    });
  };

  // Platform tokens carry a role from the platform catalog, which isn't
  // in the tenant-side `UserRole` union — cast at the sign site rather
  // than widening the shared type for a test.
  const platformToken = () =>
    app.jwt.sign({
      sub: "platform-user-1",
      email: "ops@vendor.test",
      role: "PLATFORM_ADMIN",
      platform: true,
    } as unknown as Parameters<typeof app.jwt.sign>[0]);

  return {
    app,
    tenantPrisma,
    platformPrisma,
    resolverCalls,
    token,
    platformToken,
  };
}

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

// ─── the staff surface ───────────────────────────────────────────────

/**
 * Every route group a CUSTOMER token must be turned away from, with the
 * permission that turns it away and the staff roles that legitimately
 * hold it. The `roles` column is what stops this being a one-way test:
 * over-gating (a permission no canonical role holds, or the wrong one)
 * fails just as loudly as under-gating.
 */
interface StaffRoute {
  group: string;
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  url: string;
  permission: string;
  roles: Array<keyof typeof PERMS>;
  /**
   * Body to send, for a route that now publishes a request schema.
   *
   * Fastify validates a declared body in `preValidation`, which runs
   * BEFORE the `preHandler` that checks the permission — so an empty
   * `{}` on such a route comes back 400 and the permission gate is
   * never reached, which would make this test pass or fail for a reason
   * that has nothing to do with authorization. Sending a well-formed
   * body puts the gate back in the path. Defaults to `{}` for the
   * routes that declare no body schema.
   */
  payload?: Record<string, unknown>;
}

const LOAN_ID = "11111111-1111-4111-8111-111111111111";
const CUSTOMER_ID = "22222222-2222-4222-8222-222222222222";
const PAYMENT_ID = "33333333-3333-4333-8333-333333333333";

const STAFF_ROUTES: StaffRoute[] = [
  // ── customers: full PII, and monthlyIncome feeds credit scoring ──
  {
    group: "customers",
    method: "GET",
    url: "/api/v1/customers",
    permission: "customers.read",
    roles: ["LOAN_OFFICER", "ACCOUNTANT", "ADMIN"],
  },
  {
    group: "customers",
    method: "GET",
    url: `/api/v1/customers/${CUSTOMER_ID}`,
    permission: "customers.read",
    roles: ["LOAN_OFFICER", "ACCOUNTANT", "ADMIN"],
  },
  {
    group: "customers",
    method: "GET",
    url: `/api/v1/customers/${CUSTOMER_ID}/summary`,
    permission: "customers.read",
    roles: ["LOAN_OFFICER", "ACCOUNTANT", "ADMIN"],
  },
  {
    group: "customers",
    method: "GET",
    url: `/api/v1/customers/${CUSTOMER_ID}/repeat-eligibility`,
    permission: "customers.read",
    roles: ["LOAN_OFFICER", "ACCOUNTANT", "ADMIN"],
  },
  {
    group: "customers",
    method: "POST",
    url: "/api/v1/customers",
    permission: "customers.write",
    roles: ["LOAN_OFFICER", "ADMIN"],
    payload: {
      firstName: "Test",
      lastName: "Borrower",
      dateOfBirth: "1990-01-01",
      phone: "09171234567",
      email: "test.borrower@example.com",
      address: "1 Test St",
      city: "Manila",
      governmentIdType: "NATIONAL_ID",
      governmentIdNumber: "1234-5678",
      employmentStatus: "EMPLOYED",
      employerName: "Test Co",
      monthlyIncome: 45000,
    },
  },
  {
    group: "customers",
    method: "PATCH",
    url: `/api/v1/customers/${CUSTOMER_ID}`,
    permission: "customers.write",
    roles: ["LOAN_OFFICER", "ADMIN"],
  },
  {
    group: "customers",
    method: "GET",
    url: `/api/v1/customers/${CUSTOMER_ID}/ledger`,
    permission: "customers.read",
    roles: ["LOAN_OFFICER", "ACCOUNTANT", "ADMIN"],
  },

  // ── loans ────────────────────────────────────────────────────────
  {
    group: "loans",
    method: "GET",
    url: "/api/v1/loans",
    permission: "loans.read",
    roles: ["LOAN_OFFICER", "ACCOUNTANT", "ADMIN"],
  },
  {
    group: "loans",
    method: "GET",
    url: `/api/v1/loans/${LOAN_ID}`,
    permission: "loans.read",
    roles: ["LOAN_OFFICER", "ACCOUNTANT", "ADMIN"],
  },
  {
    group: "loans",
    method: "GET",
    url: `/api/v1/loans/${LOAN_ID}/kyc-status`,
    permission: "loans.read",
    roles: ["LOAN_OFFICER", "ACCOUNTANT", "ADMIN"],
  },
  {
    group: "loans",
    method: "POST",
    url: "/api/v1/loans/apply",
    permission: "loans.apply",
    roles: ["LOAN_OFFICER", "ADMIN"],
    payload: {
      customerId: CUSTOMER_ID,
      productCode: "SALARY",
      principal: 50000,
      termMonths: 12,
      annualInterestRate: 0.24,
    },
  },
  {
    group: "loans",
    method: "POST",
    url: "/api/v1/loans/dry-run",
    permission: "loans.apply",
    roles: ["LOAN_OFFICER", "ADMIN"],
    payload: {
      customerId: CUSTOMER_ID,
      productCode: "SALARY",
      principal: 50000,
      termMonths: 12,
      annualInterestRate: 0.24,
    },
  },
  {
    group: "loans",
    method: "POST",
    url: `/api/v1/loans/${LOAN_ID}/decide`,
    permission: "loans.decide",
    roles: ["LOAN_OFFICER", "ADMIN"],
    payload: { status: "APPROVED" },
  },
  {
    group: "loans",
    method: "POST",
    url: `/api/v1/loans/${LOAN_ID}/disburse`,
    permission: "loans.disburse",
    roles: ["LOAN_OFFICER", "ADMIN"],
  },
  // Creates a LoanPayment AND posts a journal entry to the GL.
  {
    group: "loans",
    method: "POST",
    url: `/api/v1/loans/${LOAN_ID}/payments`,
    permission: "payments.record",
    roles: ["ACCOUNTANT", "ADMIN"],
    payload: { amount: 1000 },
  },
  {
    group: "loans",
    method: "GET",
    url: `/api/v1/loans/${LOAN_ID}/co-makers`,
    permission: "loans.read",
    roles: ["LOAN_OFFICER", "ACCOUNTANT", "ADMIN"],
  },

  // ── accounting: the firm's whole book ────────────────────────────
  {
    group: "accounting",
    method: "GET",
    url: "/api/v1/accounting/accounts",
    permission: "accounting.read",
    roles: ["LOAN_OFFICER", "ACCOUNTANT", "ADMIN"],
  },
  {
    group: "accounting",
    method: "GET",
    url: "/api/v1/accounting/journal",
    permission: "accounting.read",
    roles: ["LOAN_OFFICER", "ACCOUNTANT", "ADMIN"],
  },
  {
    group: "accounting",
    method: "GET",
    url: "/api/v1/accounting/reports/trial-balance",
    permission: "accounting.read",
    roles: ["LOAN_OFFICER", "ACCOUNTANT", "ADMIN"],
  },
  {
    group: "accounting",
    method: "GET",
    url: "/api/v1/accounting/reports/balance-sheet",
    permission: "accounting.read",
    roles: ["LOAN_OFFICER", "ACCOUNTANT", "ADMIN"],
  },
  {
    group: "accounting",
    method: "GET",
    url: "/api/v1/accounting/reports/income-statement",
    permission: "accounting.read",
    roles: ["LOAN_OFFICER", "ACCOUNTANT", "ADMIN"],
  },
  {
    group: "accounting",
    method: "GET",
    url: "/api/v1/accounting/periods",
    permission: "accounting.read",
    roles: ["LOAN_OFFICER", "ACCOUNTANT", "ADMIN"],
  },

  // ── documents: loan numbers are sequential, so enumerable ────────
  {
    group: "documents",
    method: "GET",
    url: `/api/v1/loans/${LOAN_ID}/agreement.pdf`,
    permission: "documents.download",
    roles: ["LOAN_OFFICER", "ACCOUNTANT", "ADMIN"],
  },
  {
    group: "documents",
    method: "GET",
    url: `/api/v1/loans/${LOAN_ID}/statement.pdf`,
    permission: "documents.download",
    roles: ["LOAN_OFFICER", "ACCOUNTANT", "ADMIN"],
  },
  {
    group: "documents",
    method: "GET",
    url: `/api/v1/loans/${LOAN_ID}/payments/${PAYMENT_ID}/receipt.pdf`,
    permission: "documents.download",
    roles: ["LOAN_OFFICER", "ACCOUNTANT", "ADMIN"],
  },

  // ── kyc ──────────────────────────────────────────────────────────
  {
    group: "kyc",
    method: "GET",
    url: "/api/v1/kyc",
    permission: "kyc.read",
    roles: ["LOAN_OFFICER", "ADMIN"],
  },
  {
    group: "kyc",
    method: "POST",
    url: "/api/v1/kyc",
    permission: "kyc.submit",
    roles: ["LOAN_OFFICER", "ADMIN"],
  },
  {
    group: "kyc",
    method: "POST",
    url: `/api/v1/kyc/${LOAN_ID}/decide`,
    permission: "kyc.decide",
    roles: ["LOAN_OFFICER", "ADMIN"],
  },
  {
    group: "kyc",
    method: "GET",
    url: `/api/v1/kyc/customers/${CUSTOMER_ID}/status`,
    permission: "kyc.read",
    roles: ["LOAN_OFFICER", "ADMIN"],
  },

  // ── collections ──────────────────────────────────────────────────
  {
    group: "collections",
    method: "GET",
    url: "/api/v1/collections/queue",
    permission: "collections.read",
    roles: ["LOAN_OFFICER", "ACCOUNTANT", "ADMIN"],
  },
  {
    group: "collections",
    method: "GET",
    url: `/api/v1/collections/loans/${LOAN_ID}/notes`,
    permission: "collections.read",
    roles: ["LOAN_OFFICER", "ACCOUNTANT", "ADMIN"],
  },
  {
    group: "collections",
    method: "POST",
    url: `/api/v1/collections/loans/${LOAN_ID}/notes`,
    permission: "collections.note",
    roles: ["LOAN_OFFICER", "ADMIN"],
    payload: { type: "CALL", body: "Reached the borrower." },
  },
  {
    group: "collections",
    method: "GET",
    url: `/api/v1/collections/loans/${LOAN_ID}/promises`,
    permission: "collections.read",
    roles: ["LOAN_OFFICER", "ACCOUNTANT", "ADMIN"],
  },

  // ── screening: sanctions / PEP hits ──────────────────────────────
  {
    group: "screening",
    method: "GET",
    url: `/api/v1/screening/customers/${CUSTOMER_ID}`,
    permission: "screening.read",
    roles: ["LOAN_OFFICER", "ADMIN"],
  },
  {
    group: "screening",
    method: "GET",
    url: `/api/v1/screening/customers/${CUSTOMER_ID}/latest`,
    permission: "screening.read",
    roles: ["LOAN_OFFICER", "ADMIN"],
  },
  {
    group: "screening",
    method: "GET",
    url: "/api/v1/screening/watchlist",
    permission: "screening.read",
    roles: ["LOAN_OFFICER", "ADMIN"],
  },

  // ── notifications / scoring / decision rules / delegations ───────
  {
    group: "notifications",
    method: "GET",
    url: "/api/v1/notifications",
    permission: "notifications.read",
    roles: ["LOAN_OFFICER", "ACCOUNTANT", "ADMIN"],
  },
  {
    group: "scoring",
    method: "GET",
    url: "/api/v1/scoring/survey/questions",
    permission: "customers.read",
    roles: ["LOAN_OFFICER", "ACCOUNTANT", "ADMIN"],
  },
  {
    group: "scoring",
    method: "POST",
    url: "/api/v1/scoring/survey/submit",
    permission: "customers.write",
    roles: ["LOAN_OFFICER", "ADMIN"],
    payload: { customerId: CUSTOMER_ID, answers: {} },
  },
  {
    group: "scoring",
    method: "GET",
    url: `/api/v1/scoring/customers/${CUSTOMER_ID}/score`,
    permission: "customers.read",
    roles: ["LOAN_OFFICER", "ACCOUNTANT", "ADMIN"],
  },
  {
    group: "decision-rules",
    method: "GET",
    url: "/api/v1/decision-rules",
    permission: "loans.read",
    roles: ["LOAN_OFFICER", "ACCOUNTANT", "ADMIN"],
  },
  {
    group: "delegations",
    method: "GET",
    url: "/api/v1/delegations/users/directory",
    permission: "loans.read",
    roles: ["LOAN_OFFICER", "ACCOUNTANT", "ADMIN"],
  },

  // ── pre-assessment ───────────────────────────────────────────────
  // A borrower has their own /portal/pre-assessments, which forces the
  // subject to their own record. These staff routes take any customerId
  // (or none at all, for a walk-in), so a CUSTOMER token must not reach
  // them — otherwise a borrower could probe the rules against anyone.
  {
    group: "pre-assessments",
    method: "GET",
    url: "/api/v1/pre-assessments",
    permission: "pre_assessment.read",
    roles: ["LOAN_OFFICER", "ADMIN"],
  },
  {
    group: "pre-assessments",
    method: "POST",
    url: "/api/v1/pre-assessments",
    permission: "pre_assessment.run",
    roles: ["LOAN_OFFICER", "ADMIN"],
  },

  // ── payments intents ─────────────────────────────────────────────
  {
    group: "payments",
    method: "POST",
    url: "/api/v1/payments/intents",
    permission: "payments.intents",
    roles: ["ACCOUNTANT", "ADMIN"],
  },
  {
    group: "payments",
    method: "GET",
    url: "/api/v1/payments/intents?loanId=x",
    permission: "payments.intents or loans.read",
    roles: ["LOAN_OFFICER", "ACCOUNTANT", "ADMIN"],
  },

  // ── the groups that were already correct — regression guard ──────
  {
    group: "admin",
    method: "GET",
    url: "/api/v1/admin/users",
    permission: "admin.users",
    roles: ["ADMIN"],
  },
  {
    group: "admin",
    method: "GET",
    url: "/api/v1/admin/roles",
    permission: "admin.roles",
    roles: ["ADMIN"],
  },
  {
    group: "audit",
    method: "GET",
    url: "/api/v1/audit",
    permission: "admin.audit_log",
    roles: ["ADMIN"],
  },
];

describe("staff routes reject a CUSTOMER token", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });

  it.each(STAFF_ROUTES)(
    "$group: $method $url → 403 (needs $permission)",
    async (route) => {
      const res = await h.app.inject({
        method: route.method,
        url: route.url,
        headers: auth(h.token("CUSTOMER")),
        payload: route.method === "GET" ? undefined : (route.payload ?? {}),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: "Forbidden" });
    },
  );

  it("rejects an unauthenticated caller before the permission check", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/v1/customers" });
    expect(res.statusCode).toBe(401);
  });
});

describe("staff routes admit the roles that hold the permission", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });

  // Guards against the opposite failure mode: gating a route on a key
  // no canonical role holds, which would lock staff out. A cleared gate
  // usually 500s on the stub Prisma — that's fine, we only care that it
  // isn't a 403.
  it.each(STAFF_ROUTES.flatMap((r) => r.roles.map((role) => ({ ...r, role }))))(
    "$role reaches $method $url",
    async (route) => {
      const res = await h.app.inject({
        method: route.method,
        url: route.url,
        headers: auth(h.token(route.role)),
        payload: route.method === "GET" ? undefined : (route.payload ?? {}),
      });
      expect(res.statusCode).not.toBe(403);
      expect(res.statusCode).not.toBe(401);
    },
  );
});

describe("borrower-reachable exceptions stay reachable", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });

  it("POST /loans/quote is open — the portal apply wizard calls it", async () => {
    const res = await h.app.inject({
      method: "POST",
      url: "/api/v1/loans/quote",
      headers: auth(h.token("CUSTOMER")),
      payload: { principal: 50000, termMonths: 12, annualInterestRate: 0.24 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ monthlyPayment: expect.any(Number) });
  });

  it("lets a borrower read the message thread on their OWN loan", async () => {
    const token = h.token("CUSTOMER", "borrower-1");
    h.tenantPrisma.user.findUnique = vi.fn(async () => ({
      customerId: CUSTOMER_ID,
    })) as never;
    h.tenantPrisma.loanApplication.findFirst = vi.fn(async () => ({
      customerId: CUSTOMER_ID,
    })) as never;

    const res = await h.app.inject({
      method: "GET",
      url: `/api/v1/loans/${LOAN_ID}/messages`,
      headers: auth(token),
    });
    expect(res.statusCode).not.toBe(403);
  });

  it("blocks a borrower from another borrower's message thread", async () => {
    const token = h.token("CUSTOMER", "borrower-2");
    h.tenantPrisma.user.findUnique = vi.fn(async () => ({
      customerId: CUSTOMER_ID,
    })) as never;
    h.tenantPrisma.loanApplication.findFirst = vi.fn(async () => ({
      customerId: "someone-else",
    })) as never;

    const res = await h.app.inject({
      method: "GET",
      url: `/api/v1/loans/${LOAN_ID}/messages`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(403);
  });

  it("blocks a portal account with no linked customer row", async () => {
    const token = h.token("CUSTOMER", "borrower-3");
    h.tenantPrisma.user.findUnique = vi.fn(async () => ({
      customerId: null,
    })) as never;

    const res = await h.app.inject({
      method: "GET",
      url: `/api/v1/loans/${LOAN_ID}/messages`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(403);
    expect(h.tenantPrisma.loanApplication.findFirst).not.toHaveBeenCalled();
  });

  it("lets staff into any thread on loans.read alone", async () => {
    const res = await h.app.inject({
      method: "GET",
      url: `/api/v1/loans/${LOAN_ID}/messages`,
      headers: auth(h.token("LOAN_OFFICER")),
    });
    expect(res.statusCode).not.toBe(403);
    // Staff short-circuit — no ownership lookup should have run.
    expect(h.tenantPrisma.user.findUnique).not.toHaveBeenCalled();
  });
});

describe("platform tokens cannot reach tenant routes", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });

  // Platform and tenant JWTs are signed with the SAME secret; the only
  // discriminator is the `platform: true` claim. Without the reciprocal
  // check in app.authenticate a vendor token walks onto every tenant
  // route, bypassing the audited impersonation flow.
  it.each([
    "/api/v1/customers",
    "/api/v1/loans",
    "/api/v1/accounting/reports/trial-balance",
    "/api/v1/audit",
  ])("401 on %s", async (url) => {
    const res = await h.app.inject({
      method: "GET",
      url,
      headers: auth(h.platformToken()),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().message).toMatch(/platform tokens/i);
  });

  it("still admits an impersonation-minted tenant token", async () => {
    // /platform/tenants/:slug/impersonate mints a *tenant* token with an
    // `impersonatedBy` block and no `platform` claim. That must keep
    // working — it's the sanctioned path.
    const token = h.app.jwt.sign({
      sub: "tenant-admin-1",
      email: "admin@tenant.test",
      role: "ADMIN",
      tenant: "default",
      impersonatedBy: {
        platformUserId: "p1",
        platformUserEmail: "ops@vendor.test",
        purpose: "support ticket 42",
      },
    });
    const res = await h.app.inject({
      method: "GET",
      url: "/api/v1/customers",
      headers: auth(token),
    });
    // 401 would mean we broke impersonation; 403 would mean the
    // resolver didn't see this user (it won't — no perms registered),
    // which is the expected outcome here. Either way, not a 401.
    expect(res.statusCode).not.toBe(401);
  });
});

describe("permission resolution is tenant-scoped", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildHarness();
  });

  // The RBAC tables (User / Role / UserRoleAssignment / Delegation)
  // live in each tenant's own schema. Resolving against app.prisma
  // reads the public schema, finds no role assignments, and denies
  // everything — MULTI_TENANT=true is unusable until the resolver gets
  // req.tenantCtx.prisma.
  it("hands requirePermission the tenant client, not the public one", async () => {
    await h.app.inject({
      method: "GET",
      url: "/api/v1/customers",
      headers: auth(h.token("LOAN_OFFICER", "officer-1")),
    });
    const call = h.resolverCalls.find((c) => c.userId === "officer-1");
    expect(call).toBeDefined();
    expect(call!.prismaLabel).toBe("tenant");
    expect(call!.prismaLabel).not.toBe("platform/public");
  });

  it("resolves once per request even across multiple gates", async () => {
    await h.app.inject({
      method: "GET",
      url: "/api/v1/customers",
      headers: auth(h.token("LOAN_OFFICER", "officer-2")),
    });
    expect(
      h.resolverCalls.filter((c) => c.userId === "officer-2"),
    ).toHaveLength(1);
  });
});
