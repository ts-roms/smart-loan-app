import { KycDuplicateError } from "@loan/db";
import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { PortalController } from "./portal.controller";

/**
 * Invariant: a duplicate KYC upload is a 409, whichever door it enters.
 *
 * `KycRepository.submit` throws `KycDuplicateError` when a document of
 * that type is already on file. The staff route has always caught it
 * and answered 409 with the existing row. The portal route did not
 * catch it at all — so a borrower re-uploading a payslip they had
 * already sent got a **500**, an ordinary and entirely expected action
 * reported as a server fault. Nothing was corrupted; the response was
 * just wrong, and wrong in the direction that makes a borrower think
 * the system is broken and try again.
 *
 * The detection is by `code`, not `instanceof` — pnpm can resolve two
 * copies of `@loan/db`, and an `instanceof` spanning them returns false
 * silently, which would restore the 500 in exactly the deployment
 * shape hardest to reproduce locally. The last test here pins that:
 * a structurally identical error from a *foreign* class must still be
 * recognised.
 */

const SUBMISSION = {
  id: "k1",
  customerId: "c1",
  documentType: "PROOF_OF_INCOME",
  status: "PENDING",
} as unknown as ConstructorParameters<typeof KycDuplicateError>[0];

const VALID_BODY = {
  documentType: "PROOF_OF_INCOME",
  documentUrl: "https://example.test/payslip.pdf",
};

/** A portal app whose submitKyc throws whatever the test supplies. */
async function appThatThrows(err: unknown): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const controller = new PortalController();

  app.addHook("onRequest", (req, _reply, done) => {
    (req as unknown as { user: { sub: string } }).user = { sub: "u1" };
    (req as unknown as { portalServices: unknown }).portalServices = {
      portal: {
        submitKyc: () => {
          throw err;
        },
      },
    };
    done();
  });
  // The guard resolves the borrower; its own behaviour is tested
  // elsewhere, so here it simply says "yes, customer c1".
  (controller as unknown as { guard: () => Promise<string> }).guard = () =>
    Promise.resolve("c1");

  app.post("/portal/kyc", controller.submitKyc);
  await app.ready();
  return app;
}

describe("portal KYC submit — duplicate handling", () => {
  it("answers 409 with the existing submission, not 500", async () => {
    const app = await appThatThrows(new KycDuplicateError(SUBMISSION));

    const res = await app.inject({
      method: "POST",
      url: "/portal/kyc",
      payload: VALID_BODY,
    });
    await app.close();

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: "Duplicate",
      existing: { id: "k1" },
    });
  });

  it("recognises the error across a duplicate module copy", async () => {
    /*
     * The same error shape from a class this module never imported —
     * what a second resolved copy of @loan/db actually produces.
     * `instanceof` returns false here; the `code` check does not.
     */
    class ForeignKycDuplicateError extends Error {
      readonly code = "KYC_DUPLICATE";
      constructor(readonly existing: unknown) {
        super("A pending PROOF_OF_INCOME submission already exists.");
      }
    }
    const app = await appThatThrows(new ForeignKycDuplicateError({ id: "k1" }));

    const res = await app.inject({
      method: "POST",
      url: "/portal/kyc",
      payload: VALID_BODY,
    });
    await app.close();

    expect(res.statusCode).toBe(409);
  });

  it("still lets an unrelated failure surface as a fault", async () => {
    // The catch must narrow. Swallowing everything into 409 would hide
    // real breakage behind a status that says "your request was fine".
    const app = await appThatThrows(new Error("database is on fire"));

    const res = await app.inject({
      method: "POST",
      url: "/portal/kyc",
      payload: VALID_BODY,
    });
    await app.close();

    expect(res.statusCode).toBe(500);
  });
});
