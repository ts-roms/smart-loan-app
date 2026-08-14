/**
 * Backend selection.
 *
 * ## The rule that matters
 *
 * An absent or blank `STORAGE_DRIVER` means local disk, silently. This
 * is a new variable arriving in deployments that are running fine
 * without it, and none of them may notice its introduction: no warning,
 * no behaviour change, no boot failure. Anything unrecognised also lands
 * on local disk rather than throwing — a typo'd driver name should
 * degrade to the safe default, not take the API down.
 *
 * The one case that *is* loud is `STORAGE_DRIVER=S3` with the bucket or
 * credentials missing. That is not an absent config, it is a stated
 * intention that cannot be honoured, and silently writing borrower KYC
 * documents to a local disk the operator believes is a bucket is the
 * worst of the available outcomes. It warns here and falls back so
 * development still runs; `validateConfig` in apps/api turns the same
 * condition into a refuse-to-boot in production, matching how the
 * notification and payment providers already behave.
 */

import { LocalDiskStorage } from "./local";
import { S3Storage } from "./s3";
import type { StorageBackend } from "./types";

export const STORAGE_DRIVERS = ["LOCAL", "S3"] as const;
export type StorageDriverName = (typeof STORAGE_DRIVERS)[number];

export interface StorageConfig {
  /** Unrecognised, empty and undefined all mean LOCAL. */
  driver?: string;
  /** Filesystem root for the local driver. */
  uploadsDir: string;
  s3Bucket?: string;
  s3Region?: string;
  s3Endpoint?: string;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
  s3SessionToken?: string;
  s3ForcePathStyle?: boolean;
}

export interface StorageLogger {
  warn: (obj: object, msg: string) => void;
}

/** Normalise a raw env value to a driver name. Never throws. */
export function resolveDriver(raw: string | undefined): StorageDriverName {
  const upper = (raw ?? "").trim().toUpperCase();
  return (STORAGE_DRIVERS as readonly string[]).includes(upper)
    ? (upper as StorageDriverName)
    : "LOCAL";
}

/**
 * Which S3 settings are required but absent? Empty means good to go.
 * Exported so `validateConfig` can report the same list at boot without
 * duplicating the knowledge of what S3 needs.
 */
export function missingS3Config(cfg: StorageConfig): string[] {
  const missing: string[] = [];
  if (!cfg.s3Bucket) missing.push("S3_BUCKET");
  if (!cfg.s3AccessKeyId) missing.push("S3_ACCESS_KEY_ID");
  if (!cfg.s3SecretAccessKey) missing.push("S3_SECRET_ACCESS_KEY");
  return missing;
}

export function createStorage(
  cfg: StorageConfig,
  log?: StorageLogger,
): StorageBackend {
  const driver = resolveDriver(cfg.driver);

  if (driver === "S3") {
    const missing = missingS3Config(cfg);
    if (missing.length > 0) {
      log?.warn(
        {},
        `[storage] STORAGE_DRIVER=S3 but missing: ${missing.join(", ")} — ` +
          `falling back to local disk at ${cfg.uploadsDir}. ` +
          `This is a hard failure in production; see config.ts.`,
      );
      return new LocalDiskStorage({ root: cfg.uploadsDir });
    }
    return new S3Storage({
      bucket: cfg.s3Bucket!,
      region: cfg.s3Region || "us-east-1",
      endpoint: cfg.s3Endpoint || undefined,
      forcePathStyle: cfg.s3ForcePathStyle,
      credentials: {
        accessKeyId: cfg.s3AccessKeyId!,
        secretAccessKey: cfg.s3SecretAccessKey!,
        sessionToken: cfg.s3SessionToken || undefined,
      },
    });
  }

  return new LocalDiskStorage({ root: cfg.uploadsDir });
}
