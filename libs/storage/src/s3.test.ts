/**
 * S3 adapter — URL shape and request construction, against an injected
 * fetch. No network, no credentials, no bucket: the point is that the
 * adapter is *constructible and correct in shape*, so adopting a real
 * bucket is a config change rather than a development project.
 */

import { describe, expect, it, vi } from "vitest";

import { UnsafeStorageKeyError } from "./key";
import { S3Storage } from "./s3";

const CREDS = { accessKeyId: "AKIA", secretAccessKey: "secret" };

function fakeFetch(res: Partial<Response> & { status: number }) {
  return vi.fn().mockResolvedValue({
    ok: res.status >= 200 && res.status < 300,
    statusText: "",
    text: async () => "",
    arrayBuffer: async () => new ArrayBuffer(0),
    body: null,
    ...res,
  });
}

function makeStorage(
  fetchImpl: ReturnType<typeof fakeFetch>,
  extra: Partial<ConstructorParameters<typeof S3Storage>[0]> = {},
) {
  return new S3Storage({
    bucket: "loan-docs",
    region: "ap-southeast-1",
    credentials: CREDS,
    fetchImpl,
    ...extra,
  });
}

describe("addressing", () => {
  it("uses virtual-host style against real AWS", () => {
    const s = makeStorage(fakeFetch({ status: 200 }));
    expect(s.urlFor("kyc/a.png")).toBe(
      "https://loan-docs.s3.ap-southeast-1.amazonaws.com/kyc/a.png",
    );
  });

  it("switches to path style when an endpoint is set, without a second flag", () => {
    const s = makeStorage(fakeFetch({ status: 200 }), {
      endpoint: "http://localhost:9000",
    });
    expect(s.urlFor("kyc/a.png")).toBe(
      "http://localhost:9000/loan-docs/kyc/a.png",
    );
  });

  it("tolerates a trailing slash on the endpoint", () => {
    const s = makeStorage(fakeFetch({ status: 200 }), {
      endpoint: "http://localhost:9000/",
    });
    expect(s.urlFor("kyc/a.png")).toBe(
      "http://localhost:9000/loan-docs/kyc/a.png",
    );
  });

  it("encodes key segments so a key cannot inject a sub-resource", () => {
    const s = makeStorage(fakeFetch({ status: 200 }));
    expect(s.urlFor("misc/a b?acl.png")).toContain("a%20b%3Facl.png");
  });

  it("refuses a traversal key before building a URL", () => {
    const s = makeStorage(fakeFetch({ status: 200 }));
    expect(() => s.urlFor("../../etc/passwd")).toThrow(UnsafeStorageKeyError);
  });

  it("requires a bucket", () => {
    expect(
      () => new S3Storage({ bucket: "", region: "x", credentials: CREDS }),
    ).toThrow(/bucket/);
  });
});

describe("requests", () => {
  it("PUTs with a signed authorization header and content type", async () => {
    const f = fakeFetch({ status: 200 });
    await makeStorage(f).put("kyc/a.png", Buffer.from("x"), {
      contentType: "image/png",
    });

    expect(f).toHaveBeenCalledOnce();
    const [url, init] = f.mock.calls[0]!;
    expect(url).toContain("/kyc/a.png");
    expect(init.method).toBe("PUT");
    expect(init.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIA\//,
    );
    expect(init.headers["content-type"]).toBe("image/png");
    expect(init.headers["content-length"]).toBe("1");
    expect(init.headers["x-amz-content-sha256"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("buffers a stream body before signing", async () => {
    const { Readable } = await import("node:stream");
    const f = fakeFetch({ status: 200 });
    await makeStorage(f).put("kyc/a.png", Readable.from([Buffer.from("abc")]));
    expect(f.mock.calls[0]![1].headers["content-length"]).toBe("3");
  });

  it("returns null rather than throwing on a 404 get", async () => {
    const f = fakeFetch({ status: 404 });
    expect(await makeStorage(f).get("kyc/missing.png")).toBeNull();
  });

  it("surfaces the S3 error body on a failure", async () => {
    const f = fakeFetch({
      status: 403,
      text: async () => "<Error><Code>AccessDenied</Code></Error>",
    });
    await expect(makeStorage(f).get("kyc/a.png")).rejects.toThrow(
      /AccessDenied/,
    );
  });

  it("treats a 404 delete as success", async () => {
    const f = fakeFetch({ status: 404 });
    await expect(
      makeStorage(f).delete("kyc/gone.png"),
    ).resolves.toBeUndefined();
  });

  it("HEADs for exists", async () => {
    const f = fakeFetch({ status: 200 });
    expect(await makeStorage(f).exists("kyc/a.png")).toBe(true);
    expect(f.mock.calls[0]![1].method).toBe("HEAD");
  });

  it("reports a missing object as not existing", async () => {
    const f = fakeFetch({ status: 404 });
    expect(await makeStorage(f).exists("kyc/a.png")).toBe(false);
  });
});
