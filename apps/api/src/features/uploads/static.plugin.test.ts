/**
 * The static gate, end to end: a real Fastify instance serving real
 * files from a temp directory through the real plugin.
 *
 * signing.test.ts covers the HMAC in isolation. This covers the part
 * that decides whether bytes leave the process — that the hook is
 * actually wired ahead of @fastify/static, that a rejection is a
 * status code and not a body, and that the public subdir still
 * serves without one.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const JWT_SECRET = "test-secret-that-is-long-enough-for-config-1234567890";

let app: FastifyInstance;
let uploadsDir: string;
let signUploadPath: typeof import("./signing").signUploadPath;

const KYC_FILE = "id-front.png";
const KYC_PATH = `/uploads/kyc/${KYC_FILE}`;
const KYC_BYTES = "kyc-image-bytes";
const LOGO_PATH = "/uploads/branding/logo.svg";

beforeAll(async () => {
  uploadsDir = await mkdtemp(join(tmpdir(), "loan-static-test-"));
  process.env.UPLOADS_DIR = uploadsDir;
  process.env.JWT_SECRET = JWT_SECRET;

  await mkdir(join(uploadsDir, "kyc"), { recursive: true });
  await mkdir(join(uploadsDir, "branding"), { recursive: true });
  await writeFile(join(uploadsDir, "kyc", KYC_FILE), KYC_BYTES);
  await writeFile(join(uploadsDir, "branding", "logo.svg"), "<svg/>");

  // Imported after the env is set — config reads JWT_SECRET at module
  // load, and the signature has to be computed with the same one the
  // plugin verifies against.
  const [{ default: Fastify }, { uploadStaticPlugin }, signing] =
    await Promise.all([
      import("fastify"),
      import("./static.plugin"),
      import("./signing"),
    ]);
  signUploadPath = signing.signUploadPath;

  app = Fastify({ logger: false });
  await app.register(uploadStaticPlugin, { root: uploadsDir });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await rm(uploadsDir, { recursive: true, force: true });
});

describe("protected uploads", () => {
  it("serves the file with a valid signature", async () => {
    const { url } = signUploadPath(KYC_PATH);
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(KYC_BYTES);
  });

  it("refuses an unsigned request — the hole this closes", async () => {
    const res = await app.inject({ method: "GET", url: KYC_PATH });
    expect(res.statusCode).toBe(403);
    // The bytes must not have leaked alongside the rejection.
    expect(res.body).not.toContain(KYC_BYTES);
  });

  it("answers 401 for an expired signature so the client re-signs", async () => {
    const { url } = signUploadPath(KYC_PATH, -1_000);
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("SignatureExpired");
  });

  it("refuses a signature minted for a different file", async () => {
    // The signed path is what's checked — not merely the presence of
    // a well-formed signature somewhere in the query.
    const other = "/uploads/kyc/some-other-file.png";
    await writeFile(join(uploadsDir, "kyc", "some-other-file.png"), "other");
    const { url } = signUploadPath(other);
    const query = url.split("?")[1];
    const res = await app.inject({
      method: "GET",
      url: `${KYC_PATH}?${query}`,
    });
    expect(res.statusCode).toBe(403);
  });

  it("refuses a tampered expiry", async () => {
    const { url } = signUploadPath(KYC_PATH);
    const [path, query] = url.split("?");
    const params = new URLSearchParams(query);
    params.set("exp", String(Number(params.get("exp")) + 3_600_000));
    const res = await app.inject({
      method: "GET",
      url: `${path}?${params.toString()}`,
    });
    expect(res.statusCode).toBe(403);
  });

  it("refuses a request to an unknown subdir", async () => {
    // Fail closed — the gate must not treat unclassified paths as
    // public just because they aren't in the protected list.
    const res = await app.inject({
      method: "GET",
      url: "/uploads/unclassified/file.png",
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("public uploads", () => {
  it("serves branding without a signature", async () => {
    // The logo renders on the login screen, before anyone holds a
    // token to sign with.
    const res = await app.inject({ method: "GET", url: LOGO_PATH });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("<svg/>");
  });

  it("still serves branding when a signature is present but wrong", async () => {
    const res = await app.inject({
      method: "GET",
      url: `${LOGO_PATH}?exp=1&sig=deadbeef`,
    });
    expect(res.statusCode).toBe(200);
  });
});
