import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { routeSchema } from "./openapi";

/**
 * A ratchet on how much of the API is actually described.
 *
 * The spec had **336 operations and zero response schemas** — every one
 * documented as "Default Response" with no shape at all. An integrator
 * could see that `GET /loans/:id` exists and learn nothing about what
 * comes back.
 *
 * Documenting 336 operations is a programme, not a change. What this
 * file does is make the progress VISIBLE and one-directional: the number
 * below is asserted, so coverage cannot quietly fall, and raising it is
 * the whole ceremony for adding more. Without it a partly-documented
 * spec looks identical to an undocumented one at a glance, and the work
 * stalls wherever it was left.
 *
 * **That programme has now landed.** Every operation the spec emits
 * carries a response schema except eleven that structurally cannot take
 * one, enumerated and explained in UNDESCRIBED below. This file does
 * not go away with it: the ratchet is what stops the coverage rotting
 * back, and it now guards the exception list too — the gap between
 * registrations and schemas is asserted EXACTLY, so both a new
 * undocumented route and a silently-dropped exception fail the suite.
 * The second test used to be a reminder that the job was unfinished;
 * read its comment for why that reminder could not simply be deleted.
 *
 * COUNTED FROM SOURCE, not from the generated spec. Generating the spec
 * means calling `buildApp()`, which connects to Postgres and seeds the
 * job table — so a spec-derived count would make this a test that fails
 * on a laptop with the database down, for a reason that has nothing to
 * do with what it checks. What is lost is small: the source count and
 * the emitted count can only disagree if `routeSchema` stops producing
 * responses, and the tests in `openapi.test.ts` assert exactly that
 * against real emitted output.
 *
 * It deliberately does not assert a percentage or a deadline. A round
 * target invites schemas written to hit it, and a schema written to hit
 * a target is the kind that says `type: object` and stops.
 */

/**
 * Routes carrying a real response schema. RAISE IT when you document
 * more; never lower it silently.
 *
 * Current: loans (39) + accounting (20) + auth (19) + rbac (18) +
 * portal (17) + cooperative (15) + scoring (15) + platform (14) +
 * collections (12) + customers (11) + dorsi (11) + repossession (11) +
 * agents (11) + payments (9) + delegations (8) + loan-products (8) +
 * reconciliation (8) + demand-letters (7) + decision-rules (7) +
 * screening (6) + system (6) + lease (6) + annual-docs (5) +
 * compliance (5) + jobs (5) + kyc (5) + assistant (4) +
 * co-maker (4) + health (3) + licensing (3) + pre-assessment (3) +
 * public (3) + audit (2) + ecl (2) + notifications (2) + uploads (2) +
 * reports (2).
 *
 * That is every operation in the spec except the eleven listed in
 * UNDESCRIBED below. The programme this file tracked is finished; what
 * remains is the ratchet, and the exceptions are now asserted exactly
 * rather than tolerated as "a remainder".
 *
 * ── Documented RESPONSE, undeclared REQUEST BODY ──
 *
 * Several routes are counted here but deliberately leave their body
 * undescribed, because the handler parses `req.body ?? {}` against an
 * all-optional schema and attaching one would turn a legal bodyless
 * POST into a 400 (`body must be object`). Measured against a running
 * server, not assumed. Each is noted in place:
 *
 *   • compliance `/customers/:id/export`
 *   • accounting `/journal/:id/reverse`
 *   • ecl `POST /runs`
 *   • licensing `POST /deactivate` — never reads `req.body` at all
 *   • platform `/tenants/:slug/retry-provisioning` and
 *     `/licenses/:jti/revoke`
 *
 * Two more leave the body undeclared because it is not JSON at all —
 * multipart, read via `req.file()`: co-maker `/:token/upload` and
 * uploads `POST /uploads-api/:subdir`.
 */
const DOCUMENTED = 328;

/**
 * The operations that deliberately carry NO response schema, and why.
 *
 * Every one of them would need `routeSchema` to describe something it
 * structurally cannot: a non-JSON content type, or a top-level `null`.
 * Omitting `response` is not a neutral act — it makes `routeSchema`
 * emit `204 No body`, which for a route whose entire purpose IS the
 * body would be a worse lie than saying nothing. So they say nothing,
 * on purpose, and this list is the record of that decision.
 *
 * EIGHT answer `application/pdf` bytes:
 *   • documents — all six (`agreement`, `statement`, `receipt`, each
 *     with an officer route and a portal mirror).
 *   • customers `/:id/ledger.pdf` and portal `/me/ledger.pdf`.
 *
 * TWO answer a literal `null` at the top level, for a record that does
 * not exist yet — not an error, an honest "nothing here":
 *   • dorsi `/board-approval/:loanId`
 *   • screening `/customers/:customerId/latest`
 *
 * ONE is a polymorphic dispatcher:
 *   • reports `/:type` returns `Array<Record<string, unknown>>` whose
 *     row shape differs per report type, and streams `text/csv` when
 *     asked. The only schema that would fit every type is "an array of
 *     objects", which is exactly the `type: object` and stop that this
 *     file's header warns a target invites. Its two siblings
 *     (`/roll-rate`, `/product-profitability`) are documented precisely
 *     because they have ONE shape each.
 *
 * Describing the first eight needs a non-JSON content-type slot in
 * `routeSchema`; that is a change to the mechanism, not to these
 * routes, and is deliberately not smuggled in here.
 */
const UNDESCRIBED = 11;

const FEATURES = join(import.meta.dirname, "..", "features");

/** Every *.routes.ts under features/, recursively. */
async function routeFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await routeFiles(full)));
    else if (entry.name.endsWith(".routes.ts")) out.push(full);
  }
  return out;
}

/**
 * Every route registration in a feature file.
 *
 * `scoped` as well as `app`, and that is a correction rather than a
 * flourish. The platform feature registers its 13 authenticated routes
 * on an encapsulated child instance (`app.register(async (scoped) =>
 * …)`), so an `app.`-only pattern counted the whole vendor control
 * plane as ONE route — the public login — and the ratchet reported 326
 * registrations against a spec that emitted 339. Thirteen operations
 * were invisible to the only thing watching, which is the failure mode
 * a coverage ratchet exists to prevent.
 *
 * With both prefixes counted, this number now equals the operation
 * count in the emitted spec exactly (339), so the cheap source count
 * and the expensive spec count agree and the header's claim that they
 * can only disagree via `routeSchema` holds again.
 */
const REGISTRATION = /\b(app|scoped)\.(get|post|put|patch|delete)\b/g;

async function countSources(): Promise<{
  documented: number;
  registrations: number;
}> {
  const files = await routeFiles(FEATURES);
  let documented = 0;
  let registrations = 0;
  for (const f of files) {
    const src = await readFile(f, "utf8");
    documented += (src.match(/routeSchema\(\{/g) ?? []).length;
    registrations += (src.match(REGISTRATION) ?? []).length;
  }
  return { documented, registrations };
}

describe("OpenAPI coverage", () => {
  it(`describes at least ${String(DOCUMENTED)} operations`, async () => {
    const { documented } = await countSources();

    expect(
      documented,
      `Response-schema coverage fell to ${String(documented)}. If you removed ` +
        "one on purpose, lower DOCUMENTED and say why in the commit.",
    ).toBeGreaterThanOrEqual(DOCUMENTED);
  });

  it("has exactly the eleven undescribed routes it accounts for", async () => {
    /*
     * This replaces a reminder that had outlived its purpose.
     *
     * The old test asserted `registrations > DOCUMENTED` — "something is
     * still undocumented" — and its own comment said that when it failed,
     * every route was described and the file should be deleted. Neither
     * half of that survives contact with the finished job.
     *
     * It would not have failed. Eleven routes cannot take a response
     * schema at all (see UNDESCRIBED above), so `registrations >
     * DOCUMENTED` stays true forever and the test would have gone on
     * reporting "the job is visibly unfinished" about a job that was
     * done — a green assertion making a false claim, which is worse than
     * a red one.
     *
     * And deleting the file would have thrown away the ratchet with the
     * reminder. The reminder was scaffolding for a programme that has
     * now landed; the ratchet is a permanent guard, and the moment it is
     * gone coverage can rot silently.
     *
     * So the reminder becomes an exact accounting. The gap is not "some
     * remainder", it is eleven specific routes with eleven written
     * reasons, and this fails in BOTH directions: add a route without a
     * schema and the gap grows; document one of the eleven (or delete
     * it) without updating UNDESCRIBED and the gap shrinks. Either way
     * somebody has to come back to this list and say which it was.
     */
    const { documented, registrations } = await countSources();

    expect(
      registrations - documented,
      `${String(documented)} of ${String(registrations)} route registrations ` +
        "carry a response schema. The gap is supposed to be exactly the " +
        `${String(UNDESCRIBED)} routes listed in UNDESCRIBED — PDF streams, ` +
        "two null-body lookups and the polymorphic reports dispatcher. If " +
        "the gap GREW, a new route landed without a schema: add one, or " +
        "add it to that list with its reason. If the gap SHRANK, an " +
        "exception was documented or removed: say which, and lower " +
        "UNDESCRIBED.",
    ).toBe(UNDESCRIBED);
  });
});

describe("a documented route is documented properly", () => {
  /**
   * Coverage counts routes; this checks one is worth counting. A schema
   * that said `type: object` and nothing else would pass the ratchet
   * while telling a reader nothing.
   */
  it("names its fields, its tag and its summary", () => {
    const s = routeSchema({
      summary: "Liveness probe.",
      tags: ["health"],
      response: z.object({ ok: z.boolean(), service: z.string() }),
    });
    const responses = s.response as Record<
      string,
      { content: Record<string, { schema: Record<string, unknown> }> }
    >;
    const schema = responses["200"]!.content["application/json"]!.schema;

    expect(s.summary).toBeTruthy();
    expect(s.tags).toContain("health");
    expect(Object.keys(schema.properties as object)).toEqual(
      expect.arrayContaining(["ok", "service"]),
    );
  });
});

describe("the helper survives a route that uses it", () => {
  it("registers and serves without altering the payload", async () => {
    /*
     * End to end through a real Fastify instance, because the risk this
     * whole design guards against — serialisation stripping fields — is
     * invisible until a response actually passes through the serialiser.
     * A field the schema never mentions must still come out the other
     * side.
     */
    const app: FastifyInstance = Fastify({ logger: false });
    app.get(
      "/thing",
      {
        schema: routeSchema({
          summary: "A thing.",
          tags: ["test"],
          response: z.object({ id: z.string() }),
        }),
      },
      async () => ({ id: "abc", undeclared: "still here" }),
    );
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/thing" });
    await app.close();

    expect(res.json()).toEqual({ id: "abc", undeclared: "still here" });
  });
});
