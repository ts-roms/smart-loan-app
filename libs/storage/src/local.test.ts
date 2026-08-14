/**
 * Local-disk adapter against a real temp directory.
 *
 * The traversal cases here are the ones that matter most: `key.test.ts`
 * proves the *validator* rejects a hostile key, this proves the
 * *adapter* neither reads nor writes anything outside its root when
 * handed one — i.e. that the validator is actually on the path.
 */

import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { UnsafeStorageKeyError } from "./key";
import { LocalDiskStorage } from "./local";

let root: string;
let outside: string;
let storage: LocalDiskStorage;

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "loan-storage-test-"));
  root = join(base, "uploads");
  outside = join(base, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  storage = new LocalDiskStorage({ root });
});

afterEach(async () => {
  await rm(dirname(root), { recursive: true, force: true });
});

describe("round-trip", () => {
  it("puts and gets a buffer", async () => {
    await storage.put("kyc/a.png", Buffer.from("bytes"));
    expect((await storage.get("kyc/a.png"))?.toString()).toBe("bytes");
  });

  it("puts a stream", async () => {
    await storage.put("kyc/b.png", Readable.from([Buffer.from("streamed")]));
    expect((await storage.get("kyc/b.png"))?.toString()).toBe("streamed");
  });

  it("creates the subdirectory on demand, as storeUpload did", async () => {
    await storage.put("collateral/deep/c.png", Buffer.from("x"));
    expect(
      await readFile(join(root, "collateral", "deep", "c.png"), "utf8"),
    ).toBe("x");
  });

  it("lays bytes out at <root>/<key>, unchanged from today", async () => {
    await storage.put("kyc/d.png", Buffer.from("onDisk"));
    // The exact path the backup tarball and existing deployments expect.
    expect(await readFile(join(root, "kyc", "d.png"), "utf8")).toBe("onDisk");
  });

  it("reads back a file written by something other than the adapter", async () => {
    // Existing files predate this lib; they must be readable as keys.
    await mkdir(join(root, "signatures"), { recursive: true });
    await writeFile(join(root, "signatures", "legacy.png"), "old");
    expect((await storage.get("signatures/legacy.png"))?.toString()).toBe(
      "old",
    );
  });

  it("streams", async () => {
    await storage.put("kyc/e.png", Buffer.from("streamout"));
    const stream = await storage.getStream("kyc/e.png");
    expect(stream).not.toBeNull();
    const chunks: Buffer[] = [];
    for await (const c of stream!) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("streamout");
  });

  it("overwrites rather than appending", async () => {
    await storage.put("kyc/f.png", Buffer.from("first"));
    await storage.put("kyc/f.png", Buffer.from("second"));
    expect((await storage.get("kyc/f.png"))?.toString()).toBe("second");
  });
});

describe("absence", () => {
  it("get returns null for a missing key", async () => {
    expect(await storage.get("kyc/nope.png")).toBeNull();
  });

  it("getStream returns null for a missing key", async () => {
    expect(await storage.getStream("kyc/nope.png")).toBeNull();
  });

  it("getStream returns null for a directory", async () => {
    await storage.put("kyc/g.png", Buffer.from("x"));
    expect(await storage.getStream("kyc")).toBeNull();
  });

  it("exists reflects reality", async () => {
    expect(await storage.exists("kyc/h.png")).toBe(false);
    await storage.put("kyc/h.png", Buffer.from("x"));
    expect(await storage.exists("kyc/h.png")).toBe(true);
  });

  it("delete removes, and is idempotent", async () => {
    await storage.put("kyc/i.png", Buffer.from("x"));
    await storage.delete("kyc/i.png");
    expect(await storage.exists("kyc/i.png")).toBe(false);
    // The 413 cleanup path can race; a second delete must not throw.
    await expect(storage.delete("kyc/i.png")).resolves.toBeUndefined();
  });
});

describe("traversal cannot escape the root", () => {
  const hostile = [
    "../outside/stolen.png",
    "../../etc/passwd",
    "kyc/../../outside/stolen.png",
    "..\\outside\\stolen.png",
    "/etc/passwd",
    "kyc/a.png\0.exe",
  ];

  it.each(hostile)("put(%j) throws and writes nothing", async (key) => {
    await expect(storage.put(key, Buffer.from("pwned"))).rejects.toThrow(
      UnsafeStorageKeyError,
    );
    // Nothing may have landed in the sibling directory.
    await expect(
      readFile(join(outside, "stolen.png"), "utf8"),
    ).rejects.toThrow();
  });

  it.each(hostile)("get(%j) throws rather than reading", async (key) => {
    await expect(storage.get(key)).rejects.toThrow(UnsafeStorageKeyError);
  });

  it.each(hostile)("delete(%j) throws rather than unlinking", async (key) => {
    await expect(storage.delete(key)).rejects.toThrow(UnsafeStorageKeyError);
  });

  it("cannot read a real file that exists just outside the root", async () => {
    await writeFile(join(outside, "secret.txt"), "top secret");
    // The file is genuinely there — this proves the rejection is the
    // key check and not merely a missing file.
    expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe(
      "top secret",
    );
    await expect(storage.get("../outside/secret.txt")).rejects.toThrow(
      UnsafeStorageKeyError,
    );
  });

  it("cannot be tricked by a key that resolves back inside", async () => {
    // `kyc/../kyc/a.png` lands in the root once resolved, but is still
    // refused: sanitising it would mean accepting `..` in general and
    // relying on resolve() for safety.
    await expect(
      storage.put("kyc/../kyc/a.png", Buffer.from("x")),
    ).rejects.toThrow(UnsafeStorageKeyError);
  });
});
