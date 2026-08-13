/*
 * `next build`, with NODE_ENV scrubbed first.
 *
 * The root `.env` sets NODE_ENV=development for the dev servers, and
 * Nx injects root .env files into every task it runs. `next build`
 * under NODE_ENV=development loads the development AND production React
 * runtimes into the same process, and every prerender then dies with
 * `Cannot read properties of null (reading 'useContext')` — ten pages,
 * no hint of the cause.
 *
 * The failure is invisible outside integration: .env is gitignored, so
 * a fresh worktree builds clean, and `pnpm run build` from this
 * directory builds clean because only Nx injects the file. Only
 * `nx build marketing-next` in a checkout that has the root .env hits
 * it — which is exactly what CI and every developer machine run.
 *
 * A shell-syntax fix (`NODE_ENV=production next build`) breaks on
 * Windows cmd, and cross-env is not a workspace dependency; a node
 * spawn is portable and adds nothing.
 */
import { spawnSync } from "node:child_process";

const env = { ...process.env };
delete env.NODE_ENV;

const result = spawnSync("npx", ["next", "build"], {
  stdio: "inherit",
  env,
  shell: process.platform === "win32",
});

process.exit(result.status ?? 1);
