/**
 * Upload route behaviour — real Fastify, real multipart parsing, real
 * filesystem writes into a temp dir.
 *
 * This module was missing from the tree entirely (routes/index.ts
 * imported it, so the API could not boot), which is the main reason it
 * gets tests: the contract it has to satisfy is spread across four
 * consumers — FileUpload.tsx, BrandingPanel.tsx, PortalKyc.tsx and the
 * `UploadSubdir` union in libs/api-client — and none of them would fail
 * loudly if the allowlists drifted.
 *
 * Everything is loaded dynamically: `config` snapshots env at module
 * load, so UPLOADS_DIR has to be set before the first import.
 */

import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { FastifyInstance } from "fastify";

const JWT_SECRET = "test-secret-not-used-anywhere-real";
const BOUNDARY = "----vitestboundary";

let uploadsDir: string;
let app: FastifyInstance;
let token: string;

/** Hand-rolled multipart body — avoids pulling in a form-data dep. */
function multipart(filename: string, contents = "hello"): string {
  return [
    `--${BOUNDARY}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    "Content-Type: application/octet-stream",
    "",
    contents,
    `--${BOUNDARY}--`,
    "",
  ].join("\r\n");
}

function post(url: string, filename: string, contents?: string) {
  return app.inject({
    method: "POST",
    url,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
    },
    payload: multipart(filename, contents),
  });
}

beforeAll(async () => {
  uploadsDir = await mkdtemp(join(tmpdir(), "loan-uploads-test-"));
  process.env.UPLOADS_DIR = uploadsDir;
  process.env.JWT_SECRET = JWT_SECRET;

  const [{ default: Fastify }, { default: multipartPlugin }, { fastifyAuth }] =
    await Promise.all([
      import("fastify"),
      import("@fastify/multipart"),
      import("@loan/auth"),
    ]);
  const { uploadRoutes } = await import("./index");

  app = Fastify({ logger: false });
  // Same 5 MB cap app.ts applies.
  await app.register(multipartPlugin, {
    limits: { fileSize: 5 * 1024 * 1024 },
  });
  await app.register(fastifyAuth, {
    secret: JWT_SECRET,
    resolvePermissions: async () => new Set<string>(),
  });
  await app.register(uploadRoutes, { prefix: "/api/v1/uploads-api" });
  await app.ready();

  token = app.jwt.sign({
    sub: "user-1",
    email: "someone@example.test",
    role: "CUSTOMER",
    tenant: "default",
  });
});

afterAll(async () => {
  await app?.close();
  await rm(uploadsDir, { recursive: true, force: true });
});

describe("POST /uploads-api/:subdir", () => {
  it("rejects an unauthenticated caller", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/uploads-api/kyc",
    });
    expect(res.statusCode).toBe(401);
  });

  it("stores the file under the subdir and returns its public URL", async () => {
    const res = await post("/api/v1/uploads-api/kyc", "id-front.png");
    expect(res.statusCode).toBe(201);

    const body = res.json();
    expect(body.url).toMatch(/^\/uploads\/kyc\/[0-9a-f-]{36}\.png$/);
    expect(body.filename).toBe(body.url.split("/").pop());

    // The URL must actually resolve on disk — app.ts serves this dir
    // statically at /uploads/, so a mismatch is a broken image in the UI.
    const onDisk = join(uploadsDir, "kyc", body.filename);
    expect((await stat(onDisk)).isFile()).toBe(true);
  });

  it("mints a fresh name per upload rather than trusting the client's", async () => {
    const a = await post("/api/v1/uploads-api/kyc", "same-name.png", "one");
    const b = await post("/api/v1/uploads-api/kyc", "same-name.png", "two");
    expect(a.json().filename).not.toBe(b.json().filename);
    expect(a.json().filename).not.toContain("same-name");
  });

  // Every subdir the client's `UploadSubdir` union can produce has to be
  // accepted, or the corresponding upload widget 400s at runtime.
  it.each(["kyc", "selfies", "collateral", "misc", "signatures", "branding"])(
    "accepts the %s subdir",
    async (subdir) => {
      const res = await post(`/api/v1/uploads-api/${subdir}`, "f.png");
      expect(res.statusCode).toBe(201);
    },
  );

  it("rejects an unknown subdir", async () => {
    const res = await post("/api/v1/uploads-api/etc", "f.png");
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/subdir/i);
  });

  it("rejects a traversal attempt in the subdir", async () => {
    // Fastify won't even route `..` here, but assert the outcome rather
    // than the mechanism: nothing may land outside the allowlisted dirs.
    const res = await post("/api/v1/uploads-api/..", "f.png");
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(await readdir(uploadsDir)).not.toContain("f.png");
  });

  it.each([".jpg", ".jpeg", ".png", ".webp", ".pdf", ".heic"])(
    "accepts %s",
    async (ext) => {
      const res = await post("/api/v1/uploads-api/misc", `doc${ext}`);
      expect(res.statusCode).toBe(201);
    },
  );

  it.each(["evil.html", "script.js", "shell.sh", "noext"])(
    "rejects %s",
    async (filename) => {
      const res = await post("/api/v1/uploads-api/misc", filename);
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toMatch(/extension/i);
    },
  );

  // SVG is same-origin executable when navigated to directly, so it's
  // confined to the admin-only branding logo.
  it("accepts svg for branding", async () => {
    const res = await post("/api/v1/uploads-api/branding", "logo.svg");
    expect(res.statusCode).toBe(201);
  });

  it.each(["kyc", "selfies", "collateral", "misc", "signatures"])(
    "rejects svg for %s",
    async (subdir) => {
      const res = await post(`/api/v1/uploads-api/${subdir}`, "logo.svg");
      expect(res.statusCode).toBe(400);
    },
  );

  it("is case-insensitive about the extension", async () => {
    const res = await post("/api/v1/uploads-api/misc", "SCAN.PNG");
    expect(res.statusCode).toBe(201);
    expect(res.json().url).toMatch(/\.png$/);
  });

  it("413s an oversized file and leaves nothing behind", async () => {
    const before = await readdir(join(uploadsDir, "misc"));
    const res = await post(
      "/api/v1/uploads-api/misc",
      "huge.png",
      "x".repeat(6 * 1024 * 1024),
    );
    expect(res.statusCode).toBe(413);
    // The partial write must be cleaned up — its URL is never returned,
    // so leaving it would just accumulate unreachable bytes.
    expect(await readdir(join(uploadsDir, "misc"))).toEqual(before);
  });
});
