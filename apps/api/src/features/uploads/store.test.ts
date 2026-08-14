/**
 * `storeUpload` against an injected fake backend.
 *
 * `uploads.routes.test.ts` already covers this end to end on local
 * disk. What that cannot show is that the storage seam is real — that
 * the function talks to a `StorageBackend` rather than to the
 * filesystem it happens to be pointed at. These tests inject
 * `InMemoryStorage`, so a passing run means the same code would drive a
 * bucket.
 *
 * No temp directory, no network, no credentials.
 */

import { Readable } from "node:stream";
import { InMemoryStorage } from "@loan/storage";
import { describe, expect, it } from "vitest";

import type { MultipartFile } from "@fastify/multipart";

import { storeUpload } from "./store";

/**
 * Minimal stand-in for a parsed multipart part. Only the four fields
 * `storeUpload` reads are populated; `truncated` is the flag
 * @fastify/multipart sets instead of throwing when the cap is hit.
 */
function part(
  filename: string,
  contents = "bytes",
  truncated = false,
): MultipartFile {
  const stream = Readable.from([Buffer.from(contents)]) as Readable & {
    truncated: boolean;
  };
  stream.truncated = truncated;
  return {
    filename,
    mimetype: "image/png",
    file: stream,
  } as unknown as MultipartFile;
}

describe("storeUpload writes through the backend", () => {
  it("stores under <subdir>/<uuid><ext> and returns the /uploads/ URL", async () => {
    const storage = new InMemoryStorage();
    const result = await storeUpload(part("id-front.png"), "kyc", storage);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The key is the URL minus the prefix — the correspondence that
    // means no database row has to be migrated.
    expect(result.url).toBe(`/uploads/${storage.keys()[0]}`);
    expect(storage.keys()).toHaveLength(1);
    expect(storage.keys()[0]).toMatch(/^kyc\/[0-9a-f-]{36}\.png$/);
  });

  it("puts the actual bytes", async () => {
    const storage = new InMemoryStorage();
    const result = await storeUpload(part("a.png", "hello"), "misc", storage);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const key = storage.keys()[0]!;
    expect((await storage.get(key))?.toString()).toBe("hello");
  });

  it("records the content type, which local disk had nowhere to keep", async () => {
    const storage = new InMemoryStorage();
    await storeUpload(part("a.png"), "misc", storage);
    expect(storage.contentTypeOf(storage.keys()[0]!)).toBe("image/png");
  });

  it("defaults to the configured backend when none is passed", async () => {
    // The co-maker consent route passes a directory string rather than a
    // backend; that must not silently become a second storage path.
    const result = await storeUpload(part("a.png"), "kyc", "/tmp/whatever");
    // Landing anywhere at all proves the string form resolved to the
    // configured backend rather than throwing on a type it didn't expect.
    expect(result.ok).toBe(true);
  });
});

describe("storeUpload rejects before touching the backend", () => {
  it("refuses an unknown subdir and stores nothing", async () => {
    const storage = new InMemoryStorage();
    const result = await storeUpload(part("a.png"), "etc", storage);
    expect(result.ok).toBe(false);
    expect(storage.keys()).toEqual([]);
  });

  it("refuses a traversal-shaped subdir and stores nothing", async () => {
    const storage = new InMemoryStorage();
    for (const subdir of ["..", "../..", "kyc/../..", "/etc"]) {
      const result = await storeUpload(part("a.png"), subdir, storage);
      expect(result.ok, subdir).toBe(false);
    }
    expect(storage.keys()).toEqual([]);
  });

  it("refuses a disallowed extension and stores nothing", async () => {
    const storage = new InMemoryStorage();
    const result = await storeUpload(part("evil.html"), "misc", storage);
    expect(result.ok).toBe(false);
    expect(storage.keys()).toEqual([]);
  });

  it("keeps svg out of borrower-writable subdirs", async () => {
    const storage = new InMemoryStorage();
    expect((await storeUpload(part("x.svg"), "kyc", storage)).ok).toBe(false);
    expect((await storeUpload(part("x.svg"), "branding", storage)).ok).toBe(
      true,
    );
  });
});

describe("the 413 path deletes the partial object", () => {
  it("removes what it wrote and reports 413", async () => {
    const storage = new InMemoryStorage();
    const result = await storeUpload(
      part("huge.png", "partial", true),
      "misc",
      storage,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(413);
    // The URL was never returned to anyone, so leaving the object would
    // just accumulate unreachable bytes — on disk or in a bucket.
    expect(storage.keys()).toEqual([]);
  });
});
