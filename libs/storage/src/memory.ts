/**
 * In-memory backend — the fake every test uses when it cares about
 * storage behaviour rather than about the filesystem.
 *
 * It is a real implementation of the interface, not a stub: it applies
 * the same key validation as the other two, so a test that passes
 * against it has proved the traversal rules hold, and a caller that
 * works here works on disk and (barring transport) on S3.
 *
 * No `localRoot`, deliberately — it behaves like a remote backend, which
 * makes it the right double for exercising the non-local serving path.
 */

import { Readable } from "node:stream";

import { assertSafeKey } from "./key";
import type { PutOptions, StorageBackend } from "./types";

export class InMemoryStorage implements StorageBackend {
  readonly driver = "S3" as const;
  /** Explicitly absent: this fake presents as a remote backend. */
  readonly localRoot = undefined;

  private readonly objects = new Map<
    string,
    { body: Buffer; contentType?: string }
  >();

  async put(
    key: string,
    body: Readable | Buffer,
    opts?: PutOptions,
  ): Promise<void> {
    assertSafeKey(key);
    const buf = Buffer.isBuffer(body) ? body : await bufferStream(body);
    this.objects.set(key, { body: buf, contentType: opts?.contentType });
  }

  async get(key: string): Promise<Buffer | null> {
    assertSafeKey(key);
    return this.objects.get(key)?.body ?? null;
  }

  async getStream(key: string): Promise<Readable | null> {
    const buf = await this.get(key);
    return buf === null ? null : Readable.from(buf);
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    this.objects.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    assertSafeKey(key);
    return this.objects.has(key);
  }

  // ── Test affordances ────────────────────────────────────────────
  /** Every key currently stored, sorted. */
  keys(): string[] {
    return [...this.objects.keys()].sort();
  }

  contentTypeOf(key: string): string | undefined {
    return this.objects.get(key)?.contentType;
  }

  clear(): void {
    this.objects.clear();
  }
}

async function bufferStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}
