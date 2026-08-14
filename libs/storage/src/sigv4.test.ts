/**
 * SigV4 against AWS's own published test vector.
 *
 * This is the test that justifies not taking `@aws-sdk/client-s3` as a
 * dependency. A signature is a pure function of its inputs, so a fixed
 * vector from the S3 documentation pins the whole chain — canonical
 * request, string to sign, key derivation, HMAC — with no network, no
 * credentials and no bucket. If any step is wrong the hex differs.
 *
 * Vector: "Example: GET Object" from the AWS S3 REST authentication
 * docs, using the standard AKIAIOSFODNN7EXAMPLE credentials.
 */

import { describe, expect, it } from "vitest";

import {
  canonicalizePath,
  canonicalizeQuery,
  EMPTY_PAYLOAD_SHA256,
  signRequest,
} from "./sigv4";

const CREDENTIALS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

const AT = new Date("2013-05-24T00:00:00Z");

describe("signRequest — AWS GET Object vector", () => {
  const signed = signRequest({
    method: "GET",
    url: "https://examplebucket.s3.amazonaws.com/test.txt",
    region: "us-east-1",
    service: "s3",
    credentials: CREDENTIALS,
    headers: { range: "bytes=0-9" },
    now: AT,
  });

  it("builds the documented canonical request", () => {
    expect(signed.canonicalRequest).toBe(
      [
        "GET",
        "/test.txt",
        "",
        "host:examplebucket.s3.amazonaws.com",
        "range:bytes=0-9",
        `x-amz-content-sha256:${EMPTY_PAYLOAD_SHA256}`,
        "x-amz-date:20130524T000000Z",
        "",
        "host;range;x-amz-content-sha256;x-amz-date",
        EMPTY_PAYLOAD_SHA256,
      ].join("\n"),
    );
  });

  it("builds the documented string to sign", () => {
    expect(signed.stringToSign).toBe(
      [
        "AWS4-HMAC-SHA256",
        "20130524T000000Z",
        "20130524/us-east-1/s3/aws4_request",
        "7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972",
      ].join("\n"),
    );
  });

  it("derives the documented signature", () => {
    expect(signed.signature).toBe(
      "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("emits an Authorization header in the documented shape", () => {
    expect(signed.headers["authorization"]).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });
});

describe("signRequest — properties", () => {
  it("hashes a non-empty payload into x-amz-content-sha256", () => {
    const signed = signRequest({
      method: "PUT",
      url: "https://examplebucket.s3.amazonaws.com/a.png",
      region: "us-east-1",
      service: "s3",
      credentials: CREDENTIALS,
      body: Buffer.from("hello"),
      now: AT,
    });
    // sha256("hello")
    expect(signed.headers["x-amz-content-sha256"]).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("changes the signature when the body changes", () => {
    const base = {
      method: "PUT",
      url: "https://examplebucket.s3.amazonaws.com/a.png",
      region: "us-east-1",
      service: "s3",
      credentials: CREDENTIALS,
      now: AT,
    } as const;
    const a = signRequest({ ...base, body: Buffer.from("one") });
    const b = signRequest({ ...base, body: Buffer.from("two") });
    expect(a.signature).not.toBe(b.signature);
  });

  it("carries a session token into the signed headers", () => {
    const signed = signRequest({
      method: "GET",
      url: "https://examplebucket.s3.amazonaws.com/a.png",
      region: "us-east-1",
      service: "s3",
      credentials: { ...CREDENTIALS, sessionToken: "tok" },
      now: AT,
    });
    expect(signed.headers["x-amz-security-token"]).toBe("tok");
    expect(signed.headers["authorization"]).toContain("x-amz-security-token");
  });
});

describe("canonicalization", () => {
  it("encodes each path segment but keeps separators", () => {
    expect(canonicalizePath("/kyc/a b.png")).toBe("/kyc/a%20b.png");
  });

  it("encodes the characters encodeURIComponent leaves alone", () => {
    expect(canonicalizePath("/x/a!'()*.png")).toBe("/x/a%21%27%28%29%2A.png");
  });

  it("sorts query parameters by key", () => {
    const q = new URLSearchParams("b=2&a=1&c=3");
    expect(canonicalizeQuery(q)).toBe("a=1&b=2&c=3");
  });
});
