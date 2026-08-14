/**
 * The storage seam.
 *
 * ## Why these methods and no others
 *
 * The interface is derived from the four places this codebase actually
 * touches stored bytes, not from the S3 API surface:
 *
 *   1. `storeUpload()` streams a multipart file in          → `put`
 *   2. the same function deletes a partial file after a 413 → `delete`
 *   3. `loadSignature()` reads a signature PNG into a PDF   → `get`
 *   4. the `/uploads/` static server streams bytes out      → `getStream`
 *                                                             + `exists`
 *
 * `exists` earns its place at (4): the server has to answer 404 *before*
 * it starts writing response headers, and asking for a stream in order
 * to discover the file is missing means unwinding a half-built reply.
 *
 * ## Why there is no `getSignedUrl`
 *
 * This is the method S3 would push hardest, and taking it would be a
 * security regression. Stored files are served from `/uploads/`, which
 * carries a `sandbox` CSP and `nosniff` (see static.plugin.ts) precisely
 * because a KYC upload is attacker-influenced bytes on a same-origin
 * path. A bucket-signed URL points the browser at the *provider's*
 * origin, where none of those headers exist and the provider decides the
 * Content-Type.
 *
 * So bytes always leave through the API, in every mode, and the
 * signed-URL notion the callers need stays what it already is: the HMAC
 * over `/uploads/...` minted by `POST /uploads-api/sign`. That lives in
 * `signing.ts` and is deliberately not part of this interface — it
 * signs a *route*, not a *bucket object*.
 */

import type { Readable } from "node:stream";

export interface PutOptions {
  /**
   * MIME type recorded with the object. The local adapter ignores it
   * (the filesystem has nowhere to put it and `@fastify/static` infers
   * the type from the extension, which is what happens today); S3
   * stores it as Content-Type.
   */
  contentType?: string;
}

export interface StorageBackend {
  /**
   * Which adapter this is, for logging and for the boot banner. Not a
   * behavioural switch — callers must not branch on it.
   */
  readonly driver: "LOCAL" | "S3";

  /**
   * Filesystem root, present only on the local-disk adapter.
   *
   * The one deliberate leak in the interface. `/uploads/` is served by
   * `@fastify/static` today, which brings Range requests, ETags and
   * conditional GETs; re-implementing that over `getStream` would be a
   * quiet behavioural regression for every existing deployment. The
   * static plugin uses this to hand local serving straight to
   * `@fastify/static` and falls back to `getStream` for anything else.
   */
  readonly localRoot?: string;

  /** Store `body` at `key`, overwriting any existing object. */
  put(key: string, body: Readable | Buffer, opts?: PutOptions): Promise<void>;

  /** Whole object as a Buffer, or null when it does not exist. */
  get(key: string): Promise<Buffer | null>;

  /** Streaming read, or null when the object does not exist. */
  getStream(key: string): Promise<Readable | null>;

  /**
   * Remove an object. Succeeds silently when the key is already absent
   * so callers don't have to race.
   *
   * See `docs` on the callers before adding one: uploaded KYC documents
   * are regulated records (§12/§71) and the only caller today is the
   * 413 cleanup path in `storeUpload`, which deletes a partial file
   * whose URL was never returned to anyone.
   */
  delete(key: string): Promise<void>;

  /** Does an object exist at `key`? */
  exists(key: string): Promise<boolean>;
}
