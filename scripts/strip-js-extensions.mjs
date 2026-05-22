#!/usr/bin/env node
/**
 * One-shot codemod: strip `.js` from relative imports across the
 * Node-executed packages. The repo runs everything via `tsx` (dev,
 * prod, Docker) with `moduleResolution: "Bundler"` + `noEmit: true`,
 * so the `.js` convention was decorative — nothing in the toolchain
 * actually requires it.
 *
 * Pattern matched:
 *
 *   from "./foo.js"           →  from "./foo"
 *   from "../bar/baz.js"      →  from "../bar/baz"
 *   from "./foo/index.js"     →  from "./foo/index"
 *
 * Bare specifiers (`@loan/...`, `lucide-react`, `fastify`, etc.) are
 * left alone — they don't carry the extension to begin with.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const FROM_RE = /from\s+"((?:\.\.?\/)[^"]+)\.js"/g;

// `git ls-files` gives us only tracked .ts/.tsx files, so generated
// artifacts and node_modules are excluded by construction. Quote with
// escaped double-quotes (not single) so the patterns survive intact
// on Windows cmd.exe — single quotes pass through literally there and
// turn into part of the pathspec string.
const out = execSync(
  'git ls-files -- "apps/api/**/*.ts" "libs/**/*.ts"',
  { encoding: "utf8" },
);
const files = out.split(/\r?\n/).filter(Boolean);

let touched = 0;
let replacements = 0;
for (const file of files) {
  const src = readFileSync(file, "utf8");
  let count = 0;
  const next = src.replace(FROM_RE, (_, path) => {
    count += 1;
    return `from "${path}"`;
  });
  if (count > 0) {
    writeFileSync(file, next);
    touched += 1;
    replacements += count;
  }
}

console.log(
  `Stripped ${replacements} .js extension(s) across ${touched} file(s).`,
);
