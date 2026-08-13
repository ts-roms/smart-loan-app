#!/usr/bin/env node
/**
 * The write journey, end to end, as one command:
 *
 *   pnpm --filter @loan/web e2e:write
 *
 * `e2e/README.md` names the reason this exists: every other journey
 * READS, because writing against the shared dev database would drift a
 * reconciled ledger on every run — and the flow most worth covering
 * (apply → approve → disburse → pay) was therefore uncovered. The fix
 * it prescribes is a disposable database per run, "not cleanup code
 * that fails halfway and leaves the ledger worse than no test at all".
 * This script is that disposable database's lifecycle:
 *
 *   1. CREATE a scratch database `smart_loan_e2e_<timestamp>` on the
 *      same dev Postgres (:5433). The name pattern is enforced by
 *      db-admin.mjs, which refuses to create or drop anything else —
 *      the dev database is unreachable by construction, not by care.
 *   2. `prisma migrate deploy` + the dev seed (staff accounts, chart
 *      of accounts, products, approval chain, decision rules) + the
 *      smoke-test fixtures (customers to lend to) + a KYC top-up
 *      (fixtures set kycStatus but create no submissions, and both
 *      the wizard and the API judge submissions).
 *   3. Boot a dedicated API on :3003 with DATABASE_URL pointed at the
 *      scratch database, and a dedicated Vite on :5183 whose proxy
 *      targets that API (e2e/write-journey/vite.config.mjs). The dev
 *      stack on :3001/:5173, if running, is untouched and unused.
 *   4. Run `playwright test --project=write-journey`.
 *   5. Tear it all down — servers killed, scratch database DROPped —
 *      in a finally block, so a failed journey still leaves nothing
 *      behind. The drop logs the remaining smart_loan_e2e_* databases
 *      so a leak would be visible in the run output, not discovered
 *      months later in `psql -l`.
 *
 * No license is minted for the scratch stack: the only feature-gated
 * endpoints (`requireFeature`) are the bulk import routes, which the
 * journey does not touch, and the web's license surface is confined to
 * Settings.
 *
 * Windows notes: children are spawned through the shell (pnpm is a
 * .cmd) and killed with `taskkill /T /F` so the whole tree dies, not
 * just the wrapper cmd.exe.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, "../../..");
const REPO_ROOT = resolve(WEB_ROOT, "../..");
const LIBS_DB = join(REPO_ROOT, "libs", "db");
const API_DIR = join(REPO_ROOT, "apps", "api");

const API_PORT = process.env.E2E_WRITE_API_PORT ?? "3003";
const WEB_PORT = process.env.E2E_WRITE_WEB_PORT ?? "5183";
// 127.0.0.1, not localhost — the dev Postgres on :5433 refuses the
// IPv6 half and Prisma reports it as a P1000 auth failure, which is a
// red herring this repo has chased before.
const ADMIN_URL =
  process.env.E2E_PG_ADMIN_URL ?? "postgres://loan:loan@127.0.0.1:5433/postgres";

const SCRATCH_NAME = `smart_loan_e2e_${Date.now()}`;
const SCRATCH_URL = ADMIN_URL.replace(/\/postgres(\?|$)/, `/${SCRATCH_NAME}$1`);

// ── Guards, before anything is created ──────────────────────────────
if (!/\/postgres(\?|$)/.test(ADMIN_URL)) {
  console.error(
    `E2E_PG_ADMIN_URL must point at the \`postgres\` maintenance database, got: ${ADMIN_URL}`,
  );
  process.exit(2);
}
// restore.sh's textual guard, adapted: whatever DATABASE_URL is
// configured in this shell (or in the repo root .env) must not be the
// database this run is about to create, migrate and later DROP.
const identity = (url) =>
  url.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@]*@/, "").split("?")[0].toLowerCase();
const configuredUrls = [process.env.DATABASE_URL];
const rootEnv = join(REPO_ROOT, ".env");
if (existsSync(rootEnv)) {
  const m = readFileSync(rootEnv, "utf8").match(/^DATABASE_URL=(.*)$/m);
  if (m) configuredUrls.push(m[1].trim().replace(/^["']|["']$/g, ""));
}
for (const configured of configuredUrls) {
  if (configured && identity(configured) === identity(SCRATCH_URL)) {
    console.error(
      "REFUSING: the scratch database resolves to the configured DATABASE_URL.",
    );
    process.exit(1);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────
const LOG_DIR = join(tmpdir(), `smart-loan-write-journey-${Date.now()}`);
mkdirSync(LOG_DIR, { recursive: true });

const t0 = Date.now();
const phases = [];
const mark = (label, since) =>
  phases.push([label, ((Date.now() - since) / 1000).toFixed(1) + "s"]);

function runStep(label, command, { cwd, env } = {}) {
  const started = Date.now();
  console.log(`\n== ${label}`);
  const res = spawnSync(command, {
    cwd: cwd ?? REPO_ROOT,
    env: { ...process.env, ...env },
    shell: true,
    stdio: "inherit",
  });
  mark(label, started);
  if (res.status !== 0) {
    throw new Error(`${label} failed (exit ${res.status ?? "?"})`);
  }
}

const children = [];
function spawnServer(label, command, { cwd, env }) {
  const logPath = join(LOG_DIR, `${label}.log`);
  console.log(`== starting ${label} (log: ${logPath})`);
  /*
   * Output is redirected to the log file BY THE SHELL, not piped back
   * to this process. That is a lesson, not a preference: the first
   * version piped stdout here and wrote it to a stream, and when that
   * drain stalled the child's 64KB stdout buffer filled — at which
   * point the API's synchronous log writes BLOCKED ITS EVENT LOOP.
   * The server answered its first few requests, froze mid-journey,
   * and every later call (including the wizard's GET /customers) hung
   * forever. A dev API logs every Prisma query; nothing that chatty
   * should depend on this process keeping up. The OS-level redirect
   * has no such dependency.
   */
  const child = spawn(`${command} > "${logPath}" 2>&1`, {
    cwd,
    env: { ...process.env, ...env },
    shell: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  children.push({ label, child, logPath });
  return child;
}

async function waitFor(url, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error(`${label} did not answer on ${url} within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

function killAll() {
  for (const { label, child } of children) {
    if (child.exitCode !== null) continue;
    console.log(`== stopping ${label}`);
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } else {
      child.kill("SIGTERM");
    }
  }
}

function tailLogs() {
  for (const { label, logPath } of children) {
    try {
      const lines = readFileSync(logPath, "utf8").split("\n");
      console.error(`\n-- last output of ${label} (${logPath}):`);
      console.error(lines.slice(-30).join("\n"));
    } catch {
      // log unreadable — nothing to show
    }
  }
}

// ── The run ─────────────────────────────────────────────────────────
let exitCode = 1;
try {
  console.log(`Scratch database: ${SCRATCH_NAME} on ${identity(ADMIN_URL)}`);

  runStep("create scratch database", `pnpm exec tsx "${join(HERE, "db-admin.mjs")}" create ${SCRATCH_NAME}`, {
    cwd: LIBS_DB,
    env: { DATABASE_URL: ADMIN_URL, NODE_ENV: "production" },
  });
  runStep("migrate", "pnpm exec prisma migrate deploy", {
    cwd: LIBS_DB,
    env: { DATABASE_URL: SCRATCH_URL },
  });
  runStep("seed (staff, chart, products, chain, rules)", "pnpm exec tsx prisma/seed.ts", {
    cwd: LIBS_DB,
    env: { DATABASE_URL: SCRATCH_URL },
  });
  runStep("fixtures (customers to lend to)", `pnpm exec tsx "${join(REPO_ROOT, "docs", "smoke-tests", "fixtures.ts")}"`, {
    cwd: LIBS_DB,
    env: { DATABASE_URL: SCRATCH_URL },
  });
  runStep("verify KYC pack for the journey's borrower", `pnpm exec tsx "${join(HERE, "seed-kyc.mjs")}"`, {
    cwd: LIBS_DB,
    env: { DATABASE_URL: SCRATCH_URL, NODE_ENV: "production" },
  });

  const bootStart = Date.now();
  spawnServer("api", "pnpm exec tsx src/main.ts", {
    cwd: API_DIR,
    env: {
      DATABASE_URL: SCRATCH_URL,
      PORT: API_PORT,
      WEB_ORIGIN: `http://localhost:${WEB_PORT}`,
      NODE_ENV: "development",
    },
  });
  spawnServer("web", "pnpm exec vite --config e2e/write-journey/vite.config.mjs", {
    cwd: WEB_ROOT,
    env: {
      E2E_WRITE_API_PORT: API_PORT,
      E2E_WRITE_WEB_PORT: WEB_PORT,
    },
  });
  await waitFor(`http://127.0.0.1:${API_PORT}/api/v1/health`, "scratch API");
  await waitFor(`http://localhost:${WEB_PORT}/`, "scratch web");
  mark("boot servers", bootStart);

  const testStart = Date.now();
  console.log("\n== playwright test --project=write-journey");
  const res = spawnSync("pnpm exec playwright test --project=write-journey", {
    cwd: WEB_ROOT,
    env: {
      ...process.env,
      E2E_WRITE_DB_URL: SCRATCH_URL,
      E2E_WRITE_WEB_URL: `http://localhost:${WEB_PORT}`,
    },
    shell: true,
    stdio: "inherit",
  });
  mark("journey", testStart);
  exitCode = res.status ?? 1;
  if (exitCode !== 0) tailLogs();
} catch (err) {
  console.error(`\n${err.message ?? err}`);
  tailLogs();
  exitCode = 1;
} finally {
  // Teardown runs on success AND failure — the entire point. Servers
  // first (they hold connections), then the DROP, which uses FORCE for
  // anything they leaked anyway.
  killAll();
  const dropStart = Date.now();
  const drop = spawnSync(
    `pnpm exec tsx "${join(HERE, "db-admin.mjs")}" drop ${SCRATCH_NAME}`,
    {
      cwd: LIBS_DB,
      env: { ...process.env, DATABASE_URL: ADMIN_URL, NODE_ENV: "production" },
      shell: true,
      stdio: "inherit",
    },
  );
  mark("teardown + drop", dropStart);
  if (drop.status !== 0) {
    console.error(
      `!! could not drop ${SCRATCH_NAME} — remove it by hand: ` +
        `DROP DATABASE "${SCRATCH_NAME}" WITH (FORCE);`,
    );
    exitCode = exitCode || 1;
  }
  console.log("\n== timings");
  for (const [label, secs] of phases) console.log(`  ${secs.padStart(7)}  ${label}`);
  console.log(`  ${(((Date.now() - t0) / 1000).toFixed(1) + "s").padStart(7)}  total`);
  process.exit(exitCode);
}
