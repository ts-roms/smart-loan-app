/**
 * AWS Signature Version 4, for S3 REST calls.
 *
 * ## Why not an SDK
 *
 * `@aws-sdk/client-s3` is the obvious answer and it is not in
 * `pnpm-lock.yaml` today. Adding it pulls ~40 transitive packages in for
 * four verbs of plain HTTP (PUT / GET / HEAD / DELETE on a single
 * object), none of which needs multipart uploads, streaming checksums,
 * credential-chain discovery or the retry middleware that makes up most
 * of that weight. Uploads here are capped at 5 MB by the multipart
 * registration in app.ts, so the whole-object PUT below is sufficient by
 * construction.
 *
 * The trade this makes is a real one: hand-rolled signing is code that
 * can be subtly wrong. That is why `sigv4.test.ts` checks it against
 * AWS's own published test vectors rather than against itself — the
 * signature is fully determined by the inputs, so a fixed vector proves
 * the implementation without a network, credentials, or a bucket.
 *
 * Node 20+ is required for global `fetch`, which `engines` already
 * pins (>=20.11.0).
 */

import { createHash, createHmac } from "node:crypto";

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** STS session token, when credentials are temporary. */
  sessionToken?: string;
}

export interface SignRequestInput {
  method: string;
  /** Absolute URL, query string included. */
  url: string;
  region: string;
  service: string;
  credentials: SigV4Credentials;
  /** Headers to sign. `host` is derived from the URL and need not appear. */
  headers?: Record<string, string>;
  /** Request body; hashed into the signature. */
  body?: Buffer;
  /** Injectable for deterministic tests. */
  now?: Date;
}

export const EMPTY_PAYLOAD_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * RFC 3986 encoding. `encodeURIComponent` leaves `!'()*` alone, and AWS
 * requires them encoded; getting this wrong produces a signature
 * mismatch only for keys containing those characters, which is exactly
 * the kind of bug that survives casual testing.
 */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Encode a URL path for the canonical request: every segment encoded,
 * the separators left as separators.
 */
export function canonicalizePath(pathname: string): string {
  if (pathname === "") return "/";
  return pathname.split("/").map(uriEncode).join("/");
}

/** Sorted, encoded query string. */
export function canonicalizeQuery(search: URLSearchParams): string {
  const pairs: Array<[string, string]> = [];
  for (const [k, v] of search) pairs.push([k, v]);
  pairs.sort((a, b) => (a[0] === b[0] ? cmp(a[1], b[1]) : cmp(a[0], b[0])));
  return pairs.map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join("&");
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `20130524T000000Z` and `20130524`. */
function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/** Derive the scoped signing key: date → region → service → aws4_request. */
export function signingKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

export interface SignedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
  /** Exposed for tests; not needed to issue the request. */
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

/**
 * Sign a request with SigV4, returning headers ready to hand to `fetch`.
 *
 * S3 requires `x-amz-content-sha256` on every signed request, so the
 * payload hash is always computed rather than sent as UNSIGNED-PAYLOAD:
 * bodies here are already buffered and at most 5 MB, and a signed
 * payload means a truncated or tampered upload fails at the service
 * rather than landing silently.
 */
export function signRequest(input: SignRequestInput): SignedRequest {
  const url = new URL(input.url);
  const body = input.body ?? Buffer.alloc(0);
  const payloadHash =
    body.length === 0 ? EMPTY_PAYLOAD_SHA256 : sha256Hex(body);
  const { amzDate, dateStamp } = amzDates(input.now ?? new Date());

  // Header names are lowercased and sorted for the canonical form; the
  // returned map keeps that casing, which is fine — HTTP header names
  // are case-insensitive and `fetch` normalises them anyway.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    headers[k.toLowerCase()] = v.trim().replace(/\s+/g, " ");
  }
  headers["host"] = url.host;
  headers["x-amz-date"] = amzDate;
  headers["x-amz-content-sha256"] = payloadHash;
  if (input.credentials.sessionToken) {
    headers["x-amz-security-token"] = input.credentials.sessionToken;
  }

  const sortedNames = Object.keys(headers).sort();
  const canonicalHeaders =
    sortedNames.map((n) => `${n}:${headers[n]}\n`).join("") || "";
  const signedHeaders = sortedNames.join(";");

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalizePath(url.pathname),
    canonicalizeQuery(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const key = signingKey(
    input.credentials.secretAccessKey,
    dateStamp,
    input.region,
    input.service,
  );
  const signature = createHmac("sha256", key)
    .update(stringToSign, "utf8")
    .digest("hex");

  headers["authorization"] =
    `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url: input.url,
    method: input.method.toUpperCase(),
    headers,
    body: body.length > 0 ? body : undefined,
    canonicalRequest,
    stringToSign,
    signature,
  };
}
