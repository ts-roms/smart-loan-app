import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll } from "vitest";

/**
 * Shared setup for the API suite. One job: no test may write into the
 * working tree.
 *
 * ## What went wrong without it
 *
 * `config.uploadsDir` falls back to `${process.cwd()}/uploads`
 * (see `resolvedUploadsDir` in src/config.ts), and under `vitest run`
 * the cwd is `apps/api`. So any test that reaches the *configured*
 * storage backend — rather than one it injected itself — wrote a real
 * file into `apps/api/uploads/`.
 *
 * One did: store.test.ts's "defaults to the configured backend when
 * none is passed" passes a plain string target, which `backendFor`
 * deliberately resolves to `uploadStorage()`. That is the behaviour the
 * test is there to pin, and it is correct — but it meant every run left
 * `apps/api/uploads/kyc/<uuid>.png` behind, in a directory that a booted
 * dev server, a second worktree or a concurrent run also owns. A test
 * that shares mutable state with anything outside its own process is a
 * flake waiting for the right interleaving.
 *
 * ## Why here rather than in the test
 *
 * `config` snapshots the environment at module load, so the variable has
 * to be set before the test file's imports are evaluated — which is
 * exactly when setup files run, and is not something a `beforeAll` can
 * do for a statically-imported module. Fixing it here also makes the
 * guarantee suite-wide instead of per-call-site: a test added tomorrow
 * that touches the configured backend lands in a temp directory without
 * anyone having to remember this.
 *
 * The directory is per test FILE, not per run: setup files are
 * re-evaluated for each file, so two files can never collide even when
 * scheduled into the same fork. The two uploads suites that mint their
 * own `mkdtemp` and set `UPLOADS_DIR` themselves are unaffected — they
 * overwrite this value before their dynamic imports, as they always did.
 */
const uploadsDir = mkdtempSync(join(tmpdir(), "loan-api-suite-uploads-"));
process.env.UPLOADS_DIR = uploadsDir;

afterAll(() => {
  // Never fail a suite over cleanup. On Windows a handle held open by a
  // Fastify instance that is still closing turns this into EBUSY, and
  // the OS reclaims the temp directory regardless.
  try {
    rmSync(uploadsDir, { recursive: true, force: true });
  } catch {
    /* empty */
  }
});
