/**
 * `@loan/storage` — the object-storage seam (roadmap 3.1).
 *
 * Local disk is the default and every existing deployment keeps using
 * it. The S3 adapter exists so that adopting a bucket is a config
 * change rather than a development project; it is constructible and
 * unit-tested, but has never been run against a live endpoint.
 *
 * See types.ts for why the interface has exactly these methods, and
 * factory.ts for the fallback rule.
 */

export { assertSafeKey, isSafeKey, UnsafeStorageKeyError } from "./key";
export { LocalDiskStorage, type LocalStorageOptions } from "./local";
export { S3Storage, type S3StorageOptions } from "./s3";
export { InMemoryStorage } from "./memory";
export {
  createStorage,
  missingS3Config,
  resolveDriver,
  STORAGE_DRIVERS,
  type StorageConfig,
  type StorageDriverName,
  type StorageLogger,
} from "./factory";
export {
  canonicalizePath,
  canonicalizeQuery,
  signRequest,
  signingKey,
  EMPTY_PAYLOAD_SHA256,
  type SignedRequest,
  type SignRequestInput,
  type SigV4Credentials,
} from "./sigv4";
export type { PutOptions, StorageBackend } from "./types";
