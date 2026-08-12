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

/**
 * Invariant: nothing served out of /uploads/ can execute.
 *
 * `store.ts` keeps `.svg` out of every borrower-writable subdir and says
 * why — uploads are served SAME-ORIGIN, so navigating directly to a
 * stored SVG runs any script inside it. That leaves `branding`, which is
 * admin-writable and PUBLIC: no signature is needed to fetch the logo,
 * because it renders on the login screen before anyone holds a token.
 *
 * So the residual vector is an admin-planted SVG on a path anyone can
 * reach. `sandbox` closes it: a sandboxed response is its own opaque
 * origin with scripting off. The file still renders, and it can no
 * longer touch the session that opened it.
 */
describe("served files cannot execute", () => {
  // Fastify types a header as string | string[] | number; only the
  // string case can occur here, and the join keeps the array case from
  // stringifying to "[object Object]" if it ever does.
  const csp = (res: { headers: Record<string, unknown> }) => {
    const h = res.headers["content-security-policy"];
    return Array.isArray(h) ? h.join(" ") : typeof h === "string" ? h : "";
  };

  it("sandboxes a signed file", async () => {
    const { url } = signUploadPath(KYC_PATH);
    const res = await app.inject({ method: "GET", url });

    expect(res.statusCode).toBe(200);
    expect(csp(res)).toContain("sandbox");
    expect(csp(res)).toContain("default-src 'none'");
  });

  it("sandboxes the PUBLIC branding path, which is the one that matters", async () => {
    // Reachable without a signature and writable by an admin. If any
    // single response needed this header, it is this one.
    const res = await app.inject({ method: "GET", url: LOGO_PATH });

    expect(res.statusCode).toBe(200);
    expect(csp(res)).toContain("sandbox");
  });

  it("sends nosniff, so a .png full of HTML stays a .png", async () => {
    const res = await app.inject({ method: "GET", url: LOGO_PATH });

    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("still lets the file itself render", async () => {
    /*
     * The bar this has to clear: the branding panel and every document
     * preview use `<img src>`, and a CSP on the IMAGE response does not
     * govern that embedding — it governs direct navigation, which is the
     * vector. A policy that broke previews would be reverted within a
     * day and the hole would come back with it.
     */
    const res = await app.inject({ method: "GET", url: LOGO_PATH });

    expect(res.body).toBe("<svg/>");
  });
});
