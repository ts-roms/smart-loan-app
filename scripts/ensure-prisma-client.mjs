#!/usr/bin/env node
/**
 * Generate the Prisma client, but only if it isn't there already.
 *
 * Why the app builds need this at all
 *
 *   `@loan/api build` and `@loan/web build` both typecheck code that
 *   imports from @loan/db. Without a generated client every `prisma.*`
 *   expression resolves to `any`, inference collapses in callbacks over
 *   query results, and the build dies on a wall of
 *   TS7006 "implicitly has an 'any' type" pointing at the callsites
 *   rather than at the real cause. Anyone who hasn't seen it before
 *   reads it as a dozen unrelated typing bugs.
 *
 *   Builders that install and immediately build — Railway/Nixpacks, a
 *   fresh CI job, a plain `pnpm install && pnpm --filter @loan/api
 *   build` — all land there.
 *
 * Why it is conditional rather than an unconditional generate
 *
 *   Unconditional was the obvious version and it breaks local work. On
 *   Windows `prisma generate` cannot replace query_engine-windows.dll.node
 *   while a dev server holds it, so building anything with `pnpm dev`
 *   running dies on:
 *
 *     EPERM: operation not permitted, rename '...query_engine-windows.dll.node'
 *
 *   Trading a clean-environment failure for one that fires during
 *   ordinary local development is a bad deal. Skipping when a client is
 *   already present avoids both: clean environments generate, local
 *   ones keep the client they have.
 *
 * What this deliberately does NOT do
 *
 *   It does not detect a client that is stale relative to schema.prisma.
 *   Changing the schema still means running `pnpm db:generate` yourself,
 *   which is the documented workflow and unchanged by this. The build
 *   scripts previously never generated at all, so this is strictly more
 *   than before and no less correct.
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Resolution is rooted at libs/db, not at this script.
 *
 * @prisma/client is a dependency of @loan/db, and pnpm's isolated
 * node_modules only exposes a package to the workspace members that
 * declare it — so from scripts/ or the repo root it doesn't resolve at
 * all, and a naive check reports "missing" for every environment,
 * generated or not.
 */
const fromDb = createRequire(join(repoRoot, "libs", "db", "package.json"));

/**
 * Is there a REAL generated client, as opposed to the placeholder?
 *
 * Merely resolving `.prisma/client` is not enough, and that mistake is
 * easy to make: @prisma/client ships a stub at that exact path so
 * imports don't hard-fail before generate has run. A plain
 * `pnpm install` therefore satisfies an existence check, the generate
 * gets skipped, and tsc fails with errors naming
 * `.prisma/client/default` — the stub — plus the TS7006 wall. Verified
 * in a clean container before this check was tightened.
 *
 * So load it and count the models. A generated client exposes every
 * model on `Prisma.ModelName` (63 for this schema); the stub exposes
 * none, or throws on require.
 *
 * Resolution is rooted at libs/db because @prisma/client is its
 * dependency — pnpm's isolated node_modules doesn't expose it to the
 * repo root, so resolving from anywhere else reports "missing"
 * everywhere, generated or not.
 */
function clientIsGenerated() {
  try {
    const fromPrismaClient = createRequire(fromDb.resolve("@prisma/client"));
    // createRequire returns the require function itself — call it.
    const generated = fromPrismaClient(".prisma/client");
    return Object.keys(generated?.Prisma?.ModelName ?? {}).length > 0;
  } catch {
    return false;
  }
}

if (clientIsGenerated()) {
  console.log("prisma client already generated — skipping");
  process.exit(0);
}

console.log("prisma client missing — generating");
try {
  // Through pnpm so the workspace filter resolves the same way it does
  // everywhere else in this repo. `shell: true` because on Windows the
  // pnpm entrypoint is a .cmd, which Node refuses to spawn directly
  // since CVE-2024-27980.
  execFileSync("pnpm", ["--filter", "@loan/db", "run", "prisma:generate"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
} catch {
  // Fail loudly and say what to do. A silent continue here just moves
  // the failure to tsc, where the message is the TS7006 wall described
  // above and tells you nothing about the cause.
  console.error(
    "\nCould not generate the Prisma client.\n" +
      "Run `pnpm db:generate` and try again. If it fails with EPERM on\n" +
      "Windows, stop the dev servers first — they hold the query engine.\n",
  );
  process.exit(1);
}
