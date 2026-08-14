/**
 * Boot-time validation of the notification provider.
 *
 * The rule under test: a mock notification provider must not start under
 * NODE_ENV=production. It is the default value, it delivers nothing, and it
 * records every send as SENT — so a production deployment that simply never
 * set NOTIFICATION_PROVIDER looks healthy in the UI while no borrower has
 * ever received a payment reminder. That is not a warning-level condition;
 * a warning is what let it run unnoticed.
 *
 * `config` reads `process.env` at module load and `isProd` is a module-level
 * const, so each case stubs the environment and re-imports through
 * `vi.resetModules()` rather than mutating a already-built config object.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

/** Load a fresh copy of config.ts under a given environment. */
async function loadConfig(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return import("./config");
}

/** Collects what validateConfig logged, so we can assert on the message. */
function recorder() {
  const errors: string[] = [];
  const warns: string[] = [];
  return {
    errors,
    warns,
    log: {
      // validateConfig calls these as (obj, message); it types them as
      // variadic unknown so a pino logger satisfies it.
      warn: (...args: unknown[]) => void warns.push(String(args[1])),
      error: (...args: unknown[]) => void errors.push(String(args[1])),
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("MOCK notification provider in production", () => {
  it("refuses to boot when NOTIFICATION_PROVIDER is unset", async () => {
    const { validateConfig } = await loadConfig({
      NODE_ENV: "production",
      // Everything else a production boot needs, so the only error under
      // test is the provider one.
      JWT_SECRET: "a-real-secret-value-that-is-long-enough",
      DATABASE_URL: "postgres://app:realpass@db:5432/smart_loan",
    });
    const r = recorder();

    expect(() => validateConfig(r.log)).toThrow(/Refusing to boot/);
    expect(r.errors.join("\n")).toMatch(/NOTIFICATION_PROVIDER=MOCK/);
  });

  it("names the fix rather than just the fault", async () => {
    const { validateConfig } = await loadConfig({
      NODE_ENV: "production",
      JWT_SECRET: "a-real-secret-value-that-is-long-enough",
      DATABASE_URL: "postgres://app:realpass@db:5432/smart_loan",
    });
    const r = recorder();
    expect(() => validateConfig(r.log)).toThrow();

    const msg = r.errors.join("\n");
    expect(msg).toMatch(/SENDGRID/);
    expect(msg).toMatch(/TWILIO/);
    // Says what is actually wrong, not just that a value is disallowed.
    expect(msg).toMatch(/delivers nothing/);
  });

  it("refuses an explicit MOCK too — the default is not the only way in", async () => {
    const { validateConfig } = await loadConfig({
      NODE_ENV: "production",
      NOTIFICATION_PROVIDER: "MOCK",
      JWT_SECRET: "a-real-secret-value-that-is-long-enough",
      DATABASE_URL: "postgres://app:realpass@db:5432/smart_loan",
    });
    expect(() => validateConfig(recorder().log)).toThrow(/Refusing to boot/);
  });

  it("refuses SES, which has no adapter and lands on the same mock", async () => {
    const { validateConfig } = await loadConfig({
      NODE_ENV: "production",
      NOTIFICATION_PROVIDER: "SES",
      AWS_REGION: "ap-southeast-1",
      JWT_SECRET: "a-real-secret-value-that-is-long-enough",
      DATABASE_URL: "postgres://app:realpass@db:5432/smart_loan",
    });
    const r = recorder();
    expect(() => validateConfig(r.log)).toThrow(/Refusing to boot/);
    expect(r.errors.join("\n")).toMatch(/no adapter/);
  });
});

describe("what production still accepts", () => {
  it("boots with SENDGRID and its credentials", async () => {
    const { validateConfig } = await loadConfig({
      NODE_ENV: "production",
      NOTIFICATION_PROVIDER: "SENDGRID",
      SENDGRID_API_KEY: "SG.real-key",
      SENDGRID_FROM_EMAIL: "noreply@acme-coop.com",
      JWT_SECRET: "a-real-secret-value-that-is-long-enough",
      DATABASE_URL: "postgres://app:realpass@db:5432/smart_loan",
    });
    expect(() => validateConfig(recorder().log)).not.toThrow();
  });

  it("boots with TWILIO and its credentials", async () => {
    const { validateConfig } = await loadConfig({
      NODE_ENV: "production",
      NOTIFICATION_PROVIDER: "TWILIO",
      TWILIO_ACCOUNT_SID: "ACreal",
      TWILIO_AUTH_TOKEN: "real-token",
      TWILIO_FROM_PHONE: "+15551234567",
      JWT_SECRET: "a-real-secret-value-that-is-long-enough",
      DATABASE_URL: "postgres://app:realpass@db:5432/smart_loan",
    });
    expect(() => validateConfig(recorder().log)).not.toThrow();
  });

  it("still refuses a named provider whose credentials are missing", async () => {
    const { validateConfig } = await loadConfig({
      NODE_ENV: "production",
      NOTIFICATION_PROVIDER: "SENDGRID",
      JWT_SECRET: "a-real-secret-value-that-is-long-enough",
      DATABASE_URL: "postgres://app:realpass@db:5432/smart_loan",
    });
    const r = recorder();
    expect(() => validateConfig(r.log)).toThrow(/Refusing to boot/);
    expect(r.errors.join("\n")).toMatch(/SENDGRID_API_KEY/);
  });
});

describe("development is unaffected", () => {
  /*
   * The mock is the correct default outside production and must stay
   * frictionless — a developer with no credentials has to be able to run
   * the API. Outside production validateConfig logs and returns.
   */
  it("boots with the mock and logs nothing about the provider", async () => {
    const { validateConfig } = await loadConfig({ NODE_ENV: "development" });
    const r = recorder();

    expect(() => validateConfig(r.log)).not.toThrow();
    expect(r.errors.join("\n")).not.toMatch(/NOTIFICATION_PROVIDER/);
    expect(r.warns.join("\n")).not.toMatch(/NOTIFICATION_PROVIDER/);
  });

  it("defaults the provider to MOCK when the variable is unset", async () => {
    const { config } = await loadConfig({ NODE_ENV: "development" });
    expect(config.notificationProvider).toBe("MOCK");
  });
});
