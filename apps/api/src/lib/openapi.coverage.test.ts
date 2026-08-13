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
 * Routes carrying a real response schema, as of the last time this was
 * raised. RAISE IT when you document more; never lower it silently.
 *
 * Current: health (3) + decision-rules (7) + accounting (19) +
 * scoring (15) + jobs (5) + reports/roll-rate (1) + loans (39) +
 * customers (11) + collections (12) + auth (19) + rbac (18) +
 * payments (9) + loan-products (8) + delegations (8) + portal (17) +
 * cooperative (15) + dorsi (11) + repossession (11) + agents (11).
 *
 * Portal is 17 of 18 (ledger.pdf answers PDF bytes); dorsi is 11 of 12
 * (the board-approval lookup can answer a literal null body). Both are
 * skipped for the same reason: routeSchema would document a JSON shape
 * those answers don't have.
 */
const DOCUMENTED = 239;

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

describe("OpenAPI coverage", () => {
  it(`describes at least ${String(DOCUMENTED)} operations`, async () => {
    const files = await routeFiles(FEATURES);
    let documented = 0;
    for (const f of files) {
      const src = await readFile(f, "utf8");
      documented += (src.match(/routeSchema\(\{/g) ?? []).length;
    }

    expect(
      documented,
      `Response-schema coverage fell to ${String(documented)}. If you removed ` +
        "one on purpose, lower DOCUMENTED and say why in the commit.",
    ).toBeGreaterThanOrEqual(DOCUMENTED);
  });

  it("still has an undocumented remainder, and says so", async () => {
    /*
     * Not a failure — a reminder. This asserts the OPPOSITE of the usual
     * coverage test: that the job is visibly unfinished, so nobody reads
     * "OpenAPI: done" off a green suite.
     *
     * It used to assert `registrations > DOCUMENTED * 5` — "less than a
     * fifth is documented" — and that multiplier was arbitrary. It fired
     * the moment coverage crossed ~20%, with 112 of 325 registrations
     * documented: a third of the way is real progress and nothing like
     * finished, so the threshold was wrong rather than the reminder.
     *
     * Replaced with the actual question — is anything still
     * undocumented? When THIS fails, every route is described and the
     * whole file can go.
     */
    const files = await routeFiles(FEATURES);
    let registrations = 0;
    for (const f of files) {
      const src = await readFile(f, "utf8");
      registrations += (
        src.match(/\bapp\.(get|post|put|patch|delete)\b/g) ?? []
      ).length;
    }

    expect(
      registrations,
      `${String(DOCUMENTED)} of ${String(registrations)} route registrations ` +
        "carry a response schema. If this now fails, every route is " +
        "documented — delete this file.",
    ).toBeGreaterThan(DOCUMENTED);
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
