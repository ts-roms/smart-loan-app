#!/usr/bin/env node
/**
 * SmartLoan — one-shot stack bootstrap.
 *
 *   pnpm start              full stack + AI (default)
 *   pnpm start:lite         full stack only, skip the 2.3 GB model pull
 *   pnpm stop               graceful shutdown of every profile
 *
 * Idempotent — safe to run on every boot. Each step checks the current
 * state and skips work that's already done:
 *
 *   • .env       copied from .env.example only if missing
 *   • Docker     containers come up via `compose up -d --build`; existing
 *                healthy ones are left alone
 *   • Migrations the api container runs `prisma migrate deploy` on every
 *                boot, so this script doesn't touch them
 *   • Seeding    Prisma seed uses upsert / findFirst — safe to re-run
 *   • Model pull `ollama list` is checked first; downloads only if absent
 *   • OLLAMA_URL written to .env only if not already set; api is
 *                restarted only when the value actually changed
 *
 * Flags (in addition to npm script presets):
 *   --lite        skip the Ollama profile (no AI assistant)
 *   --no-build    skip `docker compose --build` (faster on subsequent runs)
 *   --no-seed     skip running the seed step
 *
 * Exit code is non-zero on any health-check timeout so CI can detect it.
 */

import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';

// ─── paths + flags ─────────────────────────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const ENV = resolve(ROOT, '.env');
const ENV_EXAMPLE = resolve(ROOT, '.env.example');

const FLAGS = new Set(process.argv.slice(2));
const WITH_AI = !FLAGS.has('--lite');
const WITH_BUILD = !FLAGS.has('--no-build');
const WITH_SEED = !FLAGS.has('--no-seed');
const MODEL = process.env.OLLAMA_MODEL || 'phi3:mini';

// ─── tiny logger ───────────────────────────────────────────────────────
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

const log = {
  banner(title) {
    const line = '─'.repeat(title.length + 4);
    process.stdout.write(`\n${cyan(line)}\n  ${bold(title)}\n${cyan(line)}\n\n`);
  },
  step(label) {
    process.stdout.write(`${dim('▸')} ${label.padEnd(30)}`);
  },
  ok(detail = '') {
    process.stdout.write(`${green('✓')} ${detail}\n`);
  },
  warn(detail) {
    process.stdout.write(`${yellow('!')} ${detail}\n`);
  },
  inline(label) {
    process.stdout.write(`\n  ${label}\n\n`);
  },
  fail(detail) {
    process.stderr.write(`\n${red('✗ ' + detail)}\n`);
    process.exit(1);
  },
};

// ─── shell helpers ─────────────────────────────────────────────────────
function runQuiet(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    cwd: ROOT,
    shell: false,
    ...opts,
  });
  return {
    code: r.status ?? -1,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
    error: r.error,
  };
}

function runStreamed(cmd, args) {
  return new Promise((resolveP) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      shell: false,
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolveP(code ?? -1));
  });
}

// ─── compose v1 vs v2 detection ────────────────────────────────────────
// Docker Desktop ships `docker compose` (v2 plugin); older standalone
// installs only have `docker-compose` (v1 hyphenated). Detect once and
// return a function that builds the right argv shape for either flavour.
function detectCompose() {
  const v2 = runQuiet('docker', ['compose', 'version']);
  if (v2.code === 0) {
    return (extra) => ({ cmd: 'docker', args: ['compose', ...extra] });
  }
  const v1 = runQuiet('docker-compose', ['version']);
  if (v1.code === 0) {
    return (extra) => ({ cmd: 'docker-compose', args: [...extra] });
  }
  log.fail(
    'Neither `docker compose` nor `docker-compose` is on PATH. Install Docker Desktop.',
  );
}
const compose = detectCompose();

// ─── step 1: docker is up ──────────────────────────────────────────────
function ensureDocker() {
  log.step('Checking Docker');
  const r = runQuiet('docker', ['version', '--format', '{{.Server.Version}}']);
  if (r.code !== 0) {
    log.fail('Docker daemon is not reachable. Start Docker Desktop and retry.');
  }
  log.ok(dim(`engine ${r.stdout || '?'}`));
}

// ─── step 2: .env file ─────────────────────────────────────────────────
function ensureEnv() {
  log.step('Checking .env');
  if (existsSync(ENV)) {
    log.ok(dim('exists'));
    return;
  }
  if (!existsSync(ENV_EXAMPLE)) {
    log.fail('.env.example is missing — repo is incomplete.');
  }
  copyFileSync(ENV_EXAMPLE, ENV);
  log.ok(dim('created from .env.example'));
}

// ─── step 3: compose up ────────────────────────────────────────────────
async function dockerUp() {
  const profiles = WITH_AI
    ? ['--profile', 'full', '--profile', 'ai']
    : ['--profile', 'full'];
  const buildFlag = WITH_BUILD ? ['--build'] : [];
  const extra = [...profiles, 'up', '-d', ...buildFlag];

  log.inline(
    `Starting containers (${WITH_AI ? 'full + ai' : 'full only'})${
      WITH_BUILD ? ' — building images first' : ''
    }...`,
  );
  const { cmd, args } = compose(extra);
  const code = await runStreamed(cmd, args);
  if (code !== 0) log.fail(`docker compose up failed (exit ${code})`);
  process.stdout.write('\n');
}

// ─── step 4: wait for the api container's health endpoint ──────────────
async function waitForApi() {
  log.step('Waiting for API');
  const ok = await pollUntil(
    async () => {
      try {
        const res = await fetch('http://localhost:3001/api/v1/health/ready', {
          signal: AbortSignal.timeout(3000),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
    { timeoutMs: 120_000, intervalMs: 2_000 },
  );
  if (!ok) {
    log.fail(
      'API did not pass /health/ready within 120s. Check `docker compose logs api`.',
    );
  }
  log.ok(dim('migrations applied + healthy'));
}

// ─── step 5: seed (idempotent — uses upsert internally) ────────────────
async function seedIfRequested() {
  if (!WITH_SEED) {
    log.step('Seeding database');
    log.ok(dim('skipped (--no-seed)'));
    return;
  }
  log.step('Seeding database');
  // Run seed inside the api container so it shares the same Node + Prisma
  // client we just migrated against. The container already has tsx and
  // DATABASE_URL on env, so we invoke the source directly.
  const { cmd, args } = compose([
    'exec',
    '-T',
    'api',
    '/app/libs/db/node_modules/.bin/tsx',
    '/app/libs/db/prisma/seed.ts',
  ]);
  const r = runQuiet(cmd, args);
  if (r.code !== 0) {
    // Seed is non-fatal — the user can log in if it previously ran. Surface
    // a warning with both stdout and stderr so they can diagnose.
    const detail = (r.stderr || r.stdout || '').split('\n').slice(-3).join(' | ');
    log.warn(`seed step exited ${r.code}: ${detail}`);
    return;
  }
  log.ok(dim('idempotent upserts applied'));
}

// ─── step 6: ensure Ollama is healthy + model is pulled ────────────────
async function ensureOllamaModel() {
  log.step('Waiting for Ollama');
  const reachable = await pollUntil(
    () => {
      const { cmd, args } = compose(['exec', '-T', 'ollama', 'ollama', 'list']);
      const probe = runQuiet(cmd, args);
      return probe.code === 0;
    },
    { timeoutMs: 60_000, intervalMs: 2_000 },
  );
  if (!reachable) {
    log.warn('ollama container not responding — skipping model pull');
    return;
  }
  log.ok(dim('ready'));

  log.step(`Checking ${MODEL}`);
  // `ollama list` outputs e.g. "phi3:mini  abc123  2.3 GB  3 hours ago".
  // Match on the family name (before the tag) to be tag-tolerant.
  const family = MODEL.split(':')[0];
  const listed = compose(['exec', '-T', 'ollama', 'ollama', 'list']);
  const list = runQuiet(listed.cmd, listed.args);
  if (list.code === 0 && list.stdout.includes(family)) {
    log.ok(dim('cached'));
    return;
  }
  log.ok(dim('not cached'));
  log.inline(
    `Pulling ${bold(MODEL)} (~2.3 GB for phi3:mini, larger for llama3.1) — one-time download...`,
  );
  const pull = compose(['exec', '-T', 'ollama', 'ollama', 'pull', MODEL]);
  const code = await runStreamed(pull.cmd, pull.args);
  if (code !== 0) {
    log.warn(
      `ollama pull ${MODEL} exited ${code}. Assistant will stay on the mock provider.`,
    );
    return;
  }
  process.stdout.write('\n');
}

// ─── step 7: wire OLLAMA_URL into .env if missing ──────────────────────
function ensureOllamaEnv() {
  log.step('Wiring OLLAMA_URL');
  let content = readFileSync(ENV, 'utf8');
  const desired = 'OLLAMA_URL=http://ollama:11434';
  if (new RegExp(`^${desired.replace(/[/.]/g, '\\$&')}\\s*$`, 'm').test(content)) {
    log.ok(dim('already set'));
    return false;
  }
  // Strip any existing OLLAMA_URL line (commented or otherwise) so we
  // never end up with two entries.
  content = content
    .replace(/^#?\s*OLLAMA_URL=.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
  if (!content.endsWith('\n')) content += '\n';
  content +=
    `\n# Wired by scripts/start-all.mjs — points the api container at the\n` +
    `# Ollama container over the shared loan-net docker network.\n` +
    `${desired}\n`;
  writeFileSync(ENV, content);
  log.ok(dim('added'));
  return true;
}

// ─── step 8: restart api so the new env applies ────────────────────────
async function restartApi(reason) {
  log.step('Restarting API');
  const { cmd, args } = compose(['restart', 'api']);
  const r = runQuiet(cmd, args);
  if (r.code !== 0) {
    log.fail(`docker compose restart api failed: ${r.stderr || r.stdout}`);
  }
  log.ok(dim(reason));
  await waitForApi();
}

// ─── shared poller ─────────────────────────────────────────────────────
async function pollUntil(check, { timeoutMs, intervalMs }) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await check()) return true;
    } catch {
      /* swallow, retry */
    }
    await wait(intervalMs);
  }
  return false;
}

// ─── final summary ─────────────────────────────────────────────────────
function summary() {
  process.stdout.write('\n');
  process.stdout.write(`  ${green('●')} ${bold('SmartLoan is up')}\n\n`);
  process.stdout.write(`    Web      → ${cyan('http://localhost:5173')}\n`);
  process.stdout.write(`    API      → ${cyan('http://localhost:3001/docs')}\n`);
  process.stdout.write(
    `    pgAdmin  → ${cyan('http://localhost:5050')}   ${dim('admin@loan.local / admin')}\n`,
  );
  if (WITH_AI) {
    process.stdout.write(`    Ollama   → ${cyan('http://localhost:11434')}\n`);
  }
  process.stdout.write('\n');
  process.stdout.write(`  ${bold('Sign in:')}\n`);
  process.stdout.write(
    `    admin@loan.local   / P@ssw0rd123    ${dim('(ADMIN)')}\n`,
  );
  process.stdout.write(
    `    officer@loan.local / P@ssw0rd123    ${dim('(LOAN_OFFICER)')}\n\n`,
  );
  process.stdout.write(
    `  ${dim('Stop with `pnpm stop`. Logs: `pnpm docker:logs`.')}\n\n`,
  );
}

// ─── main ──────────────────────────────────────────────────────────────
async function main() {
  log.banner(`SmartLoan bootstrap${WITH_AI ? '' : ' (lite)'}`);

  ensureDocker();
  ensureEnv();
  await dockerUp();
  await waitForApi();
  await seedIfRequested();

  if (WITH_AI) {
    await ensureOllamaModel();
    const changed = ensureOllamaEnv();
    if (changed) {
      await restartApi('env updated');
    }
  }

  summary();
}

main().catch((err) => {
  log.fail(err?.stack || String(err));
});
