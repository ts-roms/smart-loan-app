/**
 * Centralized environment-variable parsing + validation.
 *
 * Boot rule: read every var once, here, with explicit defaults. Then the
 * rest of the codebase imports `config` and never touches `process.env`
 * again. The validate() function runs at boot and warns (in non-production)
 * or throws (in production) when required vars are missing or look unsafe.
 *
 * Single source of truth for what's actually configurable. Add new vars
 * here and document the same name in .env.example.
 */

import { join } from "node:path";

import {
  missingS3Config,
  resolveDriver,
  type StorageConfig,
} from "@loan/storage";

const isProd = (process.env.NODE_ENV ?? "development") === "production";

/** Lowercase string env var with a default. */
function str(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

/** Uppercase enum env var with a default; falls back if value not in set. */
function enumOf<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = (process.env[key] ?? "").toUpperCase() as T;
  return allowed.includes(raw) ? raw : fallback;
}

/** Numeric env var with a default. */
function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Tri-state boolean env var. `undefined` means "not set", which is
 * distinct from `false` — some settings default to something other than
 * off, and need to tell an explicit `false` from an absent variable.
 */
function bool(key: string): boolean | undefined {
  const raw = (process.env[key] ?? "").trim().toLowerCase();
  if (raw === "") return undefined;
  return raw === "true" || raw === "1" || raw === "yes";
}

const NOTIFICATION_PROVIDERS = ["MOCK", "SENDGRID", "TWILIO", "SES"] as const;
const PAYMENT_PROVIDERS = ["MOCK", "GCASH", "MAYA", "DRAGONPAY"] as const;
const AML_PROVIDERS = [
  "MOCK",
  "COMPLY_ADVANTAGE",
  "REFINITIV",
  "WORLD_CHECK",
] as const;

export type NotificationProviderName = (typeof NOTIFICATION_PROVIDERS)[number];
export type PaymentProviderName = (typeof PAYMENT_PROVIDERS)[number];
export type AmlProviderName = (typeof AML_PROVIDERS)[number];

export const config = {
  nodeEnv: str("NODE_ENV", "development"),
  isProd,

  // ── HTTP ───────────────────────────────────────────────────────────
  port: num("PORT", 3001),
  /**
   * `::`, not `0.0.0.0` — dual-stack rather than IPv4-only.
   *
   * Node binds `::` with ipv6Only off, so this still accepts IPv4
   * connections; it is strictly more permissive than the old default,
   * and `localhost:3001` in dev is unaffected.
   *
   * The reason it has to be: Railway's private network is IPv6-only.
   * Bound to 0.0.0.0 the API answers public traffic through Railway's
   * edge and looks entirely healthy, while every request from another
   * service to api.railway.internal is refused — so the nginx front-
   * ends' /api/v1 and /public proxies fail with no signal on the API
   * side at all.
   */
  host: str("HOST", "::"),
  webOrigin: str("WEB_ORIGIN", "http://localhost:5173"),
  /**
   * Where the marketing site is served. Distinct from `webOrigin` —
   * these are separate deployments, usually different hosts.
   *
   * Used to build the self-serve signup confirmation link, which has to
   * land on the marketing site's /signup/confirm page rather than the
   * tenant app: the person clicking it has no account anywhere yet.
   */
  marketingOrigin: str("MARKETING_ORIGIN", "http://localhost:5175"),
  /** Public-facing URL. Falls back to http://localhost:PORT in dev. */
  get publicApiUrl(): string {
    return process.env.PUBLIC_API_URL ?? `http://localhost:${this.port}`;
  },

  // ── Database + secrets ─────────────────────────────────────────────
  databaseUrl: str(
    "DATABASE_URL",
    "postgres://loan:loan@localhost:5432/smart_loan",
  ),
  jwtSecret: str("JWT_SECRET", "dev-only-secret-change-me"),

  // ── App metadata ───────────────────────────────────────────────────
  companyName: str("COMPANY_NAME", "SmartLoan"),
  totpIssuer: str("TOTP_ISSUER", "SmartLoan"),

  // ── Storage ────────────────────────────────────────────────────────
  uploadsDir: str("UPLOADS_DIR", ""),
  /** Falls back to `${cwd}/uploads` when blank — done lazily in app.ts. */

  /**
   * Which storage backend holds uploaded files.
   *
   * Absent, blank or unrecognised all mean LOCAL — the value every
   * deployment running today behaves as, without having the variable
   * set. Introducing this must be invisible to them, so there is
   * deliberately no warning for the unset case.
   *
   * Note this is `str`, not `enumOf`: `@loan/storage` owns the
   * normalisation (`resolveDriver`) so the lib's fallback rule is one
   * implementation rather than two that could drift apart.
   */
  storageDriver: str("STORAGE_DRIVER", ""),
  s3Bucket: str("S3_BUCKET", ""),
  s3Region: str("S3_REGION", "us-east-1"),
  /** Custom endpoint for MinIO / R2 / Spaces. Blank means real AWS S3. */
  s3Endpoint: str("S3_ENDPOINT", ""),
  s3AccessKeyId: str("S3_ACCESS_KEY_ID", ""),
  s3SecretAccessKey: str("S3_SECRET_ACCESS_KEY", ""),
  s3SessionToken: str("S3_SESSION_TOKEN", ""),
  /** Defaults to on whenever a custom endpoint is set; see @loan/storage. */
  s3ForcePathStyle: bool("S3_FORCE_PATH_STYLE"),

  // ── Observability ──────────────────────────────────────────────────
  sentryDsn: str("SENTRY_DSN", ""),

  // ── Scheduled jobs ─────────────────────────────────────────────────
  systemUserId: str("SYSTEM_USER_ID", "00000000-0000-0000-0000-000000000000"),

  // ── Multi-tenancy (Phase 2) ────────────────────────────────────────
  /**
   * When true, every tenant route requires a JWT `tenant` claim and
   * queries hit the per-tenant Postgres schema. When false (the
   * default during the Phase 2 conversion), the resolveTenant
   * preHandler is a no-op and `req.tenantCtx.prisma` is just the
   * shared `app.prisma`. See docs/multi-tenant-implementation.md.
   */
  multiTenant: (process.env.MULTI_TENANT ?? "").toLowerCase() === "true",
  /** Slug returned by resolveTenant in single-tenant mode. */
  defaultTenantSlug: str("DEFAULT_TENANT_SLUG", "default"),
  /** Per-tenant Prisma pool size. Default 3 (50 tenants × 3 = 150 conns). */
  perTenantConnectionLimit: num("PER_TENANT_CONNECTION_LIMIT", 3),

  // ── Provider selection (P1) ────────────────────────────────────────
  notificationProvider: enumOf(
    "NOTIFICATION_PROVIDER",
    NOTIFICATION_PROVIDERS,
    "MOCK",
  ),
  paymentProvider: enumOf("PAYMENT_PROVIDER", PAYMENT_PROVIDERS, "MOCK"),
  amlProvider: enumOf("AML_PROVIDER", AML_PROVIDERS, "MOCK"),

  // ── Local LLM (Ollama) ─────────────────────────────────────────────
  /**
   * When unset, the assistant routes return canned "configure Ollama"
   * responses instead of failing. Set to `http://localhost:11434`
   * once Ollama is installed on the host (https://ollama.com), or to
   * the URL of a remote Ollama deployment.
   */
  ollamaUrl: str("OLLAMA_URL", ""),
  ollamaModel: str("OLLAMA_MODEL", "phi3:mini"),
  /** Cap the assistant's output length. Keeps prompts cheap + responses tight. */
  ollamaMaxTokens: num("OLLAMA_MAX_TOKENS", 512),
};

/**
 * The uploads directory, with the `${cwd}/uploads` fallback applied.
 *
 * A function rather than a field because `process.cwd()` at module-load
 * time is not necessarily what it is at call time under tsx/vitest, and
 * because four call sites were each re-deriving this expression.
 */
export function resolvedUploadsDir(): string {
  return config.uploadsDir || join(process.cwd(), "uploads");
}

/** Shape `@loan/storage` wants. Single place that maps env → backend. */
export function storageConfig(): StorageConfig {
  return {
    driver: config.storageDriver,
    uploadsDir: resolvedUploadsDir(),
    s3Bucket: config.s3Bucket,
    s3Region: config.s3Region,
    s3Endpoint: config.s3Endpoint,
    s3AccessKeyId: config.s3AccessKeyId,
    s3SecretAccessKey: config.s3SecretAccessKey,
    s3SessionToken: config.s3SessionToken,
    s3ForcePathStyle: config.s3ForcePathStyle,
  };
}

/**
 * Boot-time validation. Hard-fails in production when something looks
 * unsafe (e.g. the default JWT secret is still in place). In development
 * it just logs warnings — we don't want to block local pnpm dev.
 *
 * Call once from main.ts before starting the server.
 */
export function validateConfig(log?: {
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}): void {
  const issues: Array<{ level: "warn" | "error"; message: string }> = [];

  // The literal dev-only secret string is a hard-fail in prod — that's the
  // file-checked-in placeholder and is a real security risk. Short secrets
  // (< 32 chars) are also a hard-fail because they're easy to brute-force.
  // The .env.example default ("change-me-in-prod-please-32-chars-minimum")
  // is 41 chars and trips neither check; we expect deployers to actually
  // override it via env, but we don't refuse to boot if they don't.
  if (
    config.jwtSecret === "dev-only-secret-change-me" ||
    config.jwtSecret.length < 32
  ) {
    issues.push({
      level: isProd ? "error" : "warn",
      message:
        "JWT_SECRET is using the dev default or is < 32 chars. Set a strong secret before production.",
    });
  }

  // The default loan:loan DB creds are baked into .env.example for dev
  // convenience. We warn even in production but don't hard-fail; deployers
  // who care will see the warning and rotate the creds.
  if (config.databaseUrl.includes("loan:loan@")) {
    issues.push({
      level: "warn",
      message:
        "DATABASE_URL is using the default `loan:loan` credentials. Change before production.",
    });
  }

  if (isProd && !config.sentryDsn) {
    issues.push({
      level: "warn",
      message:
        "SENTRY_DSN is empty in production — errors will only land in logs.",
    });
  }

  if (
    isProd &&
    config.systemUserId === "00000000-0000-0000-0000-000000000000"
  ) {
    issues.push({
      level: "warn",
      message:
        "SYSTEM_USER_ID still defaults to zero-UUID. Seed a real system user for clearer audit trails.",
    });
  }

  // Warn when a real provider is selected but its credentials are absent.
  if (config.notificationProvider !== "MOCK") {
    const missing = expectedNotificationCreds(config.notificationProvider);
    if (missing.length > 0) {
      issues.push({
        level: "error",
        message: `NOTIFICATION_PROVIDER=${config.notificationProvider} but missing: ${missing.join(", ")}`,
      });
    }
  }
  if (config.paymentProvider !== "MOCK") {
    const missing = expectedPaymentCreds(config.paymentProvider);
    if (missing.length > 0) {
      issues.push({
        level: "error",
        message: `PAYMENT_PROVIDER=${config.paymentProvider} but missing: ${missing.join(", ")}`,
      });
    }
  }

  /*
   * Same rule as the providers above, and for a sharper reason. An
   * operator who sets STORAGE_DRIVER=S3 believes borrower KYC documents
   * are landing in a bucket. If the credentials are absent the backend
   * falls back to local disk — correct for development, but in
   * production it means regulated records accumulating on an ephemeral
   * container filesystem that nothing is backing up, while the config
   * says otherwise. Refuse to boot instead.
   *
   * An UNSET driver is not checked at all: local disk is the supported
   * default, not a degraded mode.
   */
  if (resolveDriver(config.storageDriver) === "S3") {
    const missing = missingS3Config(storageConfig());
    if (missing.length > 0) {
      issues.push({
        level: "error",
        message: `STORAGE_DRIVER=S3 but missing: ${missing.join(", ")}. Uploads would silently fall back to local disk.`,
      });
    }
  }

  const errors = issues.filter((i) => i.level === "error");
  const warns = issues.filter((i) => i.level === "warn");
  for (const w of warns) log?.warn?.({}, `[config] ${w.message}`);
  for (const e of errors) log?.error?.({}, `[config] ${e.message}`);
  if (isProd && errors.length > 0) {
    throw new Error(
      `Refusing to boot in production with ${errors.length} config error(s). See logs above.`,
    );
  }
}

function expectedNotificationCreds(
  provider: NotificationProviderName,
): string[] {
  switch (provider) {
    case "SENDGRID":
      return ["SENDGRID_API_KEY", "SENDGRID_FROM_EMAIL"].filter(
        (k) => !process.env[k],
      );
    case "TWILIO":
      return [
        "TWILIO_ACCOUNT_SID",
        "TWILIO_AUTH_TOKEN",
        "TWILIO_FROM_PHONE",
      ].filter((k) => !process.env[k]);
    case "SES":
      return ["AWS_REGION"].filter((k) => !process.env[k]);
    case "MOCK":
      return [];
  }
}

function expectedPaymentCreds(provider: PaymentProviderName): string[] {
  switch (provider) {
    case "GCASH":
      return ["GCASH_MERCHANT_ID", "GCASH_API_KEY"].filter(
        (k) => !process.env[k],
      );
    case "MAYA":
      return ["MAYA_PUBLIC_KEY", "MAYA_SECRET_KEY"].filter(
        (k) => !process.env[k],
      );
    case "DRAGONPAY":
      return ["DRAGONPAY_MERCHANT_ID", "DRAGONPAY_PASSWORD"].filter(
        (k) => !process.env[k],
      );
    case "MOCK":
      return [];
  }
}
