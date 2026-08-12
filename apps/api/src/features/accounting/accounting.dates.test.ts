/**
 * The date query parameters on the accounting reads.
 *
 * Two things are asserted here, and they pull against each other — which
 * is the whole reason this file exists rather than a schema change.
 *
 *  1. `?asOf=garbage` is the CALLER's mistake and must read as one. It
 *     used to answer 500 Internal Server Error: `parseAsOf` threw a bare
 *     Error, nothing caught it, and Fastify reported a client typo as a
 *     server fault. It now answers 400 with the house
 *     `{ error: "ValidationError", issues: [...] }`, naming the
 *     parameter at fault the way every other validated route does.
 *
 *  2. A DATE-ONLY "2026-08-07" must still work, and must still mean the
 *     whole local day. That is the constraint that rules out the obvious
 *     fix: `z.coerce.date()` or a `format: date-time` on the query
 *     schema would have Fastify reject the date-only shape before the
 *     handler ever ran — and date-only is the shape these parameters are
 *     FOR (see `endOfDay` in @loan/accounting, and the ₱15,668.78 it was
 *     introduced to stop losing).
 *
 * Real route plugin, real auth, real serialisation. Only Prisma is
 * stubbed — and the 400 cases never reach it, which is itself part of
 * what "the request was rejected as invalid" means.
 */

import { DEFAULT_ROLE_BY_KEY, fastifyAuth } from "@loan/auth";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { validationBodyOf } from "../../lib/validation-error";
import { accountingRoutes } from "./index";

const JWT_SECRET = "test-secret-not-used-anywhere-real";

/** Valid uuid, so `/ledger/:accountId` clears its params schema. */
const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

interface Harness {
  app: FastifyInstance;
  /** Stands in for the whole ORM; only the journal read needs it. */
  findMany: ReturnType<typeof vi.fn>;
  token: string;
}

async function buildHarness(): Promise<Harness> {
  const app = Fastify({ logger: false });
  const findMany = vi.fn(async () => []);
  const prisma = { journalEntry: { findMany } };

  /*
   * The first two lines of the app's error handler, copied rather than
   * imported: the real one is welded to the Sentry wiring inside
   * `buildApp()`, which wants a database. What it does with a thrown
   * validation error is the part under test, and that part is one call
   * to the shared `validationBodyOf` — so a drift between this and
   * app.ts can only be a drift in the Sentry branch, not in the body.
   */
  app.setErrorHandler((err: FastifyError, _req, reply) => {
    const body = validationBodyOf(err);
    if (body) return reply.code(400).send(body);
    return reply.send(err);
  });

  app.decorate("prisma", prisma as never);
  app.decorate("tenantPrisma", { get: () => prisma } as never);

  await app.register(fastifyAuth, {
    secret: JWT_SECRET,
    resolvePermissions: async () =>
      new Set(DEFAULT_ROLE_BY_KEY.ACCOUNTANT!.permissions),
  });

  const resolveTenant = async (req: { tenantCtx?: unknown }) => {
    req.tenantCtx = { slug: "default", prisma };
  };
  app.decorate("resolveTenant", resolveTenant as never);

  await app.register(accountingRoutes, { prefix: "/accounting" });
  await app.ready();

  const token = app.jwt.sign({
    sub: "user-accountant",
    email: "accountant@example.test",
    role: "ACCOUNTANT",
    tenant: "default",
  });

  return { app, findMany, token };
}

/** Every read that takes a date, and the parameter it should blame. */
const BAD_DATE_CALLS: [url: string, param: string][] = [
  ["/accounting/journal?from=garbage", "from"],
  ["/accounting/journal?to=garbage", "to"],
  [`/accounting/ledger/${ACCOUNT_ID}?from=garbage`, "from"],
  [`/accounting/ledger/${ACCOUNT_ID}?to=garbage`, "to"],
  ["/accounting/reports/trial-balance?asOf=garbage", "asOf"],
  ["/accounting/reports/income-statement?from=garbage", "from"],
  ["/accounting/reports/income-statement?to=garbage", "to"],
  ["/accounting/reports/balance-sheet?asOf=garbage", "asOf"],
  ["/accounting/reports/loan-portfolio?asOf=garbage", "asOf"],
  ["/accounting/reports/portfolio-summary?asOf=garbage", "asOf"],
  ["/accounting/reports/originations?from=garbage", "from"],
  ["/accounting/reports/originations?to=garbage", "to"],
];

describe("an unparseable date parameter", () => {
  it.each(BAD_DATE_CALLS)("%s answers 400 blaming `%s`", async (url, param) => {
    const { app, findMany, token } = await buildHarness();
    const res = await app.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${token}` },
    });
    await app.close();

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: "ValidationError",
      issues: [{ path: [param], in: "querystring" }],
    });
    // A rejected request must not have queried anything first.
    expect(findMany).not.toHaveBeenCalled();
  });

  it("says what it wanted instead", async () => {
    const { app, token } = await buildHarness();
    const res = await app.inject({
      method: "GET",
      url: "/accounting/reports/trial-balance?asOf=garbage",
      headers: { authorization: `Bearer ${token}` },
    });
    await app.close();

    /*
     * The message survives serialisation. It is not decoration: the 400
     * response schema describes an issue as a bare object, and Fastify
     * strips any property a schema does not mention — an earlier version
     * of that schema flattened every issue to `{}`.
     */
    const { issues } = res.json<{ issues: { message: string }[] }>();
    expect(issues[0]!.message).toMatch(/YYYY-MM-DD/);
  });
});

describe("a date-only parameter", () => {
  it("still means the whole local day", async () => {
    const { app, findMany, token } = await buildHarness();
    const res = await app.inject({
      method: "GET",
      url: "/accounting/journal?from=2026-08-07&to=2026-08-07",
      headers: { authorization: `Bearer ${token}` },
    });
    await app.close();

    expect(res.statusCode).toBe(200);

    const { entryDate } = (
      findMany.mock.calls[0]![0] as {
        where: { entryDate: { gte: Date; lte: Date } };
      }
    ).where;

    // Local midnight to local 23:59:59.999 — NOT UTC midnight, which in
    // Manila would have started the range at 8am and dropped a day.
    expect(entryDate.gte).toEqual(new Date(2026, 7, 7, 0, 0, 0, 0));
    expect(entryDate.lte).toEqual(new Date(2026, 7, 7, 23, 59, 59, 999));
  });

  it("is accepted by the route's own query schema", async () => {
    /*
     * Guards the fix that would look tidiest and be wrong: moving the
     * date check into the query schema as `z.coerce.date()` or a
     * `format: date-time`. Either would make Fastify reject this call
     * with its own 400 before the handler ran, and this assertion — a
     * 200 — is what would catch that.
     */
    const { app, token } = await buildHarness();
    const res = await app.inject({
      method: "GET",
      url: "/accounting/journal?from=2026-08-07",
      headers: { authorization: `Bearer ${token}` },
    });
    await app.close();

    expect(res.statusCode).toBe(200);
  });
});
