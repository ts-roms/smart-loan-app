/**
 * Backend selection, and the fallback rule that protects deployments
 * which have never heard of STORAGE_DRIVER.
 */

import { describe, expect, it, vi } from "vitest";

import { createStorage, missingS3Config, resolveDriver } from "./factory";
import { LocalDiskStorage } from "./local";
import { S3Storage } from "./s3";

const UPLOADS = "/var/lib/smart-loan/uploads";

describe("resolveDriver — anything unclear means LOCAL", () => {
  it.each([
    [undefined, "LOCAL"],
    ["", "LOCAL"],
    ["   ", "LOCAL"],
    ["local", "LOCAL"],
    ["LOCAL", "LOCAL"],
    ["s3", "S3"],
    ["S3", "S3"],
    [" s3 ", "S3"],
    // A typo must degrade to the safe default rather than take the API
    // down at boot.
    ["S£", "LOCAL"],
    ["gcs", "LOCAL"],
    ["minio", "LOCAL"],
  ])("%j → %s", (raw, expected) => {
    expect(resolveDriver(raw)).toBe(expected);
  });
});

describe("createStorage", () => {
  it("defaults to local disk when the variable is absent", () => {
    const log = { warn: vi.fn() };
    const storage = createStorage({ uploadsDir: UPLOADS }, log);
    expect(storage).toBeInstanceOf(LocalDiskStorage);
    expect(storage.driver).toBe("LOCAL");
    // Silently. An existing deployment must not start logging warnings
    // because a variable it has never set still isn't set.
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("defaults to local disk when the variable is blank", () => {
    const log = { warn: vi.fn() };
    const storage = createStorage({ driver: "", uploadsDir: UPLOADS }, log);
    expect(storage.driver).toBe("LOCAL");
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("roots the local adapter at uploadsDir", () => {
    const storage = createStorage({ uploadsDir: UPLOADS });
    expect(storage.localRoot).toBeDefined();
  });

  it("builds an S3 backend when fully configured", () => {
    const storage = createStorage({
      driver: "S3",
      uploadsDir: UPLOADS,
      s3Bucket: "loan-docs",
      s3Region: "ap-southeast-1",
      s3AccessKeyId: "AKIA",
      s3SecretAccessKey: "secret",
    });
    expect(storage).toBeInstanceOf(S3Storage);
    expect(storage.driver).toBe("S3");
    // No localRoot: the static server must take the streaming path.
    expect(storage.localRoot).toBeUndefined();
  });

  it("warns loudly and falls back when S3 is asked for but unconfigured", () => {
    const log = { warn: vi.fn() };
    const storage = createStorage({ driver: "S3", uploadsDir: UPLOADS }, log);
    // Falls back so development still runs...
    expect(storage).toBeInstanceOf(LocalDiskStorage);
    // ...but says so, because writing KYC documents to a local disk the
    // operator believes is a bucket is the worst available outcome.
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn.mock.calls[0]![1]).toContain("S3_BUCKET");
  });

  it("does not throw when S3 is unconfigured and no logger is given", () => {
    expect(() =>
      createStorage({ driver: "S3", uploadsDir: UPLOADS }),
    ).not.toThrow();
  });
});

describe("missingS3Config", () => {
  it("lists every absent setting", () => {
    expect(missingS3Config({ uploadsDir: UPLOADS })).toEqual([
      "S3_BUCKET",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
    ]);
  });

  it("is empty when complete", () => {
    expect(
      missingS3Config({
        uploadsDir: UPLOADS,
        s3Bucket: "b",
        s3AccessKeyId: "k",
        s3SecretAccessKey: "s",
      }),
    ).toEqual([]);
  });
});
