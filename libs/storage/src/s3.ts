/**
 * S3-compatible adapter. Works against AWS S3, MinIO, Cloudflare R2 or
 * DigitalOcean Spaces — anything that speaks the S3 REST API.
 *
 * **Not exercised against a live endpoint anywhere in this repo.** It is
 * constructible, unit-tested for URL shape and request signing, and
 * wired into the factory, so switching a deployment over is a matter of
 * setting env vars. What it has not had is a round-trip against a real
 * bucket; see the note at the bottom of this comment.
 *
 * ## Addressing
 *
 * Virtual-host style (`https://bucket.s3.region.amazonaws.com/key`) is
 * the default because AWS has deprecated path-style for new buckets.
 * MinIO and most local setups need path-style
 * (`http://localhost:9000/bucket/key`), which is why `forcePathStyle`
 * exists and why setting a custom `endpoint` turns it on by default —
 * an operator pointing at MinIO should not also have to know to flip a
 * second flag.
 *
 * ## What is deliberately missing
 *
 * Multipart upload. Objects here are capped at 5 MB by the multipart
 * registration in app.ts, well under the 5 GB single-PUT limit, so a
 * whole-object PUT is correct by construction rather than by luck. If
 * that cap is ever raised past ~100 MB this needs revisiting.
 */

import { Readable } from "node:stream";

import { assertSafeKey } from "./key";
import { signRequest, type SigV4Credentials } from "./sigv4";
import type { PutOptions, StorageBackend } from "./types";

export interface S3StorageOptions {
  bucket: string;
  region: string;
  credentials: SigV4Credentials;
  /** Custom endpoint for MinIO/R2/Spaces. Empty means real AWS S3. */
  endpoint?: string;
  /** Path-style addressing. Defaults to true when `endpoint` is set. */
  forcePathStyle?: boolean;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class S3Storage implements StorageBackend {
  readonly driver = "S3" as const;
  /**
   * Explicitly absent. There is no filesystem to hand to
   * `@fastify/static`, so the static server takes the streaming branch
   * and every `/uploads/` response keeps its CSP and `nosniff`.
   */
  readonly localRoot = undefined;

  private readonly bucket: string;
  private readonly region: string;
  private readonly credentials: SigV4Credentials;
  private readonly origin: string;
  private readonly pathStyle: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: S3StorageOptions) {
    if (!opts.bucket) throw new Error("S3Storage requires a bucket");
    this.bucket = opts.bucket;
    this.region = opts.region || "us-east-1";
    this.credentials = opts.credentials;
    this.pathStyle = opts.forcePathStyle ?? Boolean(opts.endpoint);
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;

    if (opts.endpoint) {
      this.origin = opts.endpoint.replace(/\/+$/, "");
    } else if (this.pathStyle) {
      this.origin = `https://s3.${this.region}.amazonaws.com`;
    } else {
      this.origin = `https://${this.bucket}.s3.${this.region}.amazonaws.com`;
    }
  }

  /**
   * Absolute URL for an object.
   *
   * The key is validated first, then each segment is encoded. Encoding
   * matters beyond cosmetics: an unencoded key could otherwise inject a
   * `?` and turn a GetObject into a sub-resource call on the bucket.
   */
  urlFor(key: string): string {
    assertSafeKey(key);
    const encoded = key.split("/").map(encodeURIComponent).join("/");
    const prefix = this.pathStyle ? `/${this.bucket}` : "";
    return `${this.origin}${prefix}/${encoded}`;
  }

  private async send(
    method: string,
    key: string,
    body?: Buffer,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const signed = signRequest({
      method,
      url: this.urlFor(key),
      region: this.region,
      service: "s3",
      credentials: this.credentials,
      headers: extraHeaders,
      body,
    });
    return this.fetchImpl(signed.url, {
      method: signed.method,
      headers: signed.headers,
      body: signed.body,
    });
  }

  private static async fail(res: Response, what: string): Promise<never> {
    // S3 returns its diagnosis in an XML body; without it the caller
    // sees a bare 403 and cannot tell a credential problem from a
    // policy one.
    const detail = await res.text().catch(() => "");
    throw new Error(
      `S3 ${what} failed: ${res.status} ${res.statusText}${
        detail ? ` — ${detail.slice(0, 500)}` : ""
      }`,
    );
  }

  async put(
    key: string,
    body: Readable | Buffer,
    opts?: PutOptions,
  ): Promise<void> {
    // Buffered rather than streamed: a signed PUT needs the payload hash
    // up front, and the alternative (streaming chunked signing) is a
    // large chunk of protocol for objects that are 5 MB at most.
    const buf = Buffer.isBuffer(body) ? body : await bufferStream(body);
    const headers: Record<string, string> = {
      "content-length": String(buf.byteLength),
    };
    if (opts?.contentType) headers["content-type"] = opts.contentType;

    const res = await this.send("PUT", key, buf, headers);
    if (!res.ok) await S3Storage.fail(res, `PUT ${key}`);
  }

  async get(key: string): Promise<Buffer | null> {
    const res = await this.send("GET", key);
    if (res.status === 404) return null;
    if (!res.ok) await S3Storage.fail(res, `GET ${key}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async getStream(key: string): Promise<Readable | null> {
    const res = await this.send("GET", key);
    if (res.status === 404) return null;
    if (!res.ok) await S3Storage.fail(res, `GET ${key}`);
    if (!res.body) return Readable.from([]);
    return Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  }

  async delete(key: string): Promise<void> {
    const res = await this.send("DELETE", key);
    // DeleteObject answers 204 for a key that was never there, which is
    // the idempotence the interface promises.
    if (!res.ok && res.status !== 404) {
      await S3Storage.fail(res, `DELETE ${key}`);
    }
  }

  async exists(key: string): Promise<boolean> {
    const res = await this.send("HEAD", key);
    if (res.status === 404) return false;
    if (!res.ok) await S3Storage.fail(res, `HEAD ${key}`);
    return true;
  }
}

async function bufferStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}
