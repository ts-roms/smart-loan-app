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
  host: str("HOST", "0.0.0.0"),
  webOrigin: str("WEB_ORIGIN", "http://localhost:5173"),
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

  // ── Observability ──────────────────────────────────────────────────
  sentryDsn: str("SENTRY_DSN", ""),

  // ── Scheduled jobs ─────────────────────────────────────────────────
  systemUserId: str("SYSTEM_USER_ID", "00000000-0000-0000-0000-000000000000"),

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
   * responses instead of failing. Set to `http://ollama:11434` (docker
   * compose service name) in full-stack deployments or `http://localhost:11434`
   * for a host-running Ollama.
   */
  ollamaUrl: str("OLLAMA_URL", ""),
  ollamaModel: str("OLLAMA_MODEL", "phi3:mini"),
  /** Cap the assistant's output length. Keeps prompts cheap + responses tight. */
  ollamaMaxTokens: num("OLLAMA_MAX_TOKENS", 512),
};

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
  // The docker-compose default ("change-me-in-prod-please-32-chars-minimum")
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

  // The default loan:loan DB creds are baked into docker-compose for dev
  // convenience — full-stack `docker compose up` would refuse to start
  // otherwise. We warn even in production but don't hard-fail; deployers
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
