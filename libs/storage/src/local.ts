/**
 * Local-disk adapter — the default, and what every existing deployment
 * keeps using.
 *
 * This is a faithful extraction of what `storeUpload` and
 * `loadSignature` already did: `mkdir -p` the parent, stream into the
 * file, read it back, unlink it. Nothing about the on-disk layout
 * changes, so an existing `UPLOADS_DIR` works untouched and the backup
 * tarball keeps covering exactly what it covered before.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { assertSafeKey, UnsafeStorageKeyError } from "./key";
import type { PutOptions, StorageBackend } from "./types";

export interface LocalStorageOptions {
  /** Directory that holds every object. Created lazily on first write. */
  root: string;
}

/** Node's "file is not there" errno, which is not an error to us. */
function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "ENOENT"
  );
}

export class LocalDiskStorage implements StorageBackend {
  readonly driver = "LOCAL" as const;
  readonly localRoot: string;

  constructor(opts: LocalStorageOptions) {
    this.localRoot = resolve(opts.root);
  }

  /**
   * Key → absolute path, checked twice.
   *
   * `assertSafeKey` is the real gate and rejects every traversal shape
   * before a path is built at all. The containment check afterwards is
   * belt and braces against a case the string rules can't see: a root
   * that is itself a symlink, or a platform quirk in `resolve()`. It
   * costs one string compare per call and means the invariant "nothing
   * escapes localRoot" holds even if the key rules are later loosened.
   */
  private pathFor(key: string): string {
    assertSafeKey(key);
    const full = resolve(join(this.localRoot, key));
    if (full !== this.localRoot && !full.startsWith(this.localRoot + sep)) {
      throw new UnsafeStorageKeyError(key, "resolves outside the storage root");
    }
    return full;
  }

  async put(
    key: string,
    body: Readable | Buffer,
    _opts?: PutOptions,
  ): Promise<void> {
    const full = this.pathFor(key);
    await mkdir(dirname(full), { recursive: true });
    const source = Buffer.isBuffer(body) ? Readable.from(body) : body;
    await pipeline(source, createWriteStream(full));
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathFor(key));
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async getStream(key: string): Promise<Readable | null> {
    const full = this.pathFor(key);
    // stat first so a missing object is a null return rather than an
    // error event on a stream the caller has already been handed.
    try {
      const info = await stat(full);
      if (!info.isFile()) return null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    return createReadStream(full);
  }

  async delete(key: string): Promise<void> {
    // `force` makes an already-absent key a no-op, matching S3's
    // DeleteObject, which is likewise idempotent.
    await rm(this.pathFor(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      return (await stat(this.pathFor(key))).isFile();
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }
}
