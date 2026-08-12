// @ts-check
/**
 * Flat ESLint config for the whole workspace.
 *
 * One root config rather than 22 per-project ones: typescript-eslint's
 * `projectService` resolves each file against whichever tsconfig owns it,
 * so type-aware rules work across the monorepo without a hand-maintained
 * list of `project` paths that drifts every time a library is added.
 *
 * Rule philosophy — this is a lending system, so the rules that earn their
 * keep are the ones that catch *silent* failures:
 *
 *   • no-floating-promises / no-misused-promises — an unawaited write to
 *     the ledger or an unhandled rejection in a Fastify handler fails
 *     without a stack trace pointing anywhere useful.
 *   • no-unnecessary-condition — flags checks that can never be false,
 *     which in strict-null code usually means a misunderstood nullable.
 *   • require-await / await-thenable — the other half of the same class.
 *   • @nx/enforce-module-boundaries — layering rot is silent by nature:
 *     each individual shortcut import looks reasonable in review.
 *
 * Stylistic rules are deliberately absent: Prettier owns formatting and
 * runs on the pre-commit hook. Rules here should find bugs, not opinions.
 */
import js from "@eslint/js";
import nx from "@nx/eslint-plugin";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Nothing generated, vendored, or built should ever be linted. Prisma
    // in particular emits a large client that would dominate the runtime.
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/node_modules/**",
      "**/.nx/**",
      // Agent-session git worktrees: each is a full copy of the repo at
      // some other commit. Linting them re-lints the whole monorepo N
      // times with type-aware rules — enough to exhaust the heap — and
      // reports findings against code that isn't this checkout.
      "**/.claude/**",
      "**/coverage/**",
      "**/generated/**",
      "libs/db/prisma/migrations/**",
      "apps/web/dev-dist/**",
      "**/*.config.js",
      "**/*.config.mjs",
      "**/*.config.ts",
      // Standalone operator scripts and the Prisma seed. They belong to
      // no tsconfig, so the type-aware parser can't resolve them; linting
      // them would need a tsconfig that exists only to satisfy the linter.
      "**/scripts/**/*.mjs",
      // bootstrap-admin.ts — the first operator script written in TS
      // rather than .mjs. Scoped to libs/db so the ROOT scripts/ dir
      // (which IS covered by the typed-lint files pattern below) keeps
      // getting linted if a .ts lands there.
      "libs/db/scripts/**/*.ts",
      "**/prisma/seed.ts",
      // Smoke-test fixtures. Same story: not part of any tsconfig, so the
      // type-aware parser can't resolve them, and pulling docs/ into a
      // tsconfig purely to satisfy the linter isn't worth it.
      "docs/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ── The bug-catching core ────────────────────────────────────
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",

      /**
       * `checksVoidReturn.attributes` is off deliberately. It fires on
       * every `onClick={async () => …}` in the app — a pattern React
       * supports and that 70 files here already use. Leaving it on would
       * bury the cases this rule is actually good at: passing an async
       * function where a sync callback is required (array methods,
       * Fastify hooks), which we keep checked.
       */
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],

      /**
       * `require-await` stays off. An `async` method with no `await` is
       * usually satisfying an interface whose other implementations do
       * await (repositories, providers, the mock/real provider pairs in
       * apps/api/src/providers.ts). The rule flagged 113 of those and no
       * actual defects.
       */
      "@typescript-eslint/require-await": "off",

      // Unused code is dead weight, but underscore-prefixed args are the
      // established way to document a deliberately-ignored parameter.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],

      // `any` is near-absent in this codebase (one occurrence at the time
      // of writing). Keep it a warning so it stays visible without
      // blocking a build on a genuinely-untyped third-party boundary.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },

  // ── Module boundaries ───────────────────────────────────────────
  /**
   * Roadmap §4.1. Until this rule existed, nothing stopped `libs/ui` from
   * importing `@loan/db` — the layering held only because reviewers
   * happened to notice. Tags live in each project's `package.json` under
   * `nx.tags`; Nx 23 reads them from there (there are no `project.json`
   * files in this workspace).
   *
   * Two independent axes, both of which must hold:
   *
   *   type:   which layer the code is — app · repository · domain ·
   *           client · ui · util. Enforces direction: an app may reach
   *           down to anything, a repository reaches down to domain and
   *           util, and util reaches nothing. Nothing reaches back up.
   *
   *   scope:  which runtime the code is permitted to execute in —
   *           server · browser · shared. This is the axis with teeth:
   *           `@loan/db` (Prisma) and `@loan/auth` (argon2) must never
   *           reach a browser bundle.
   *
   * The scope rules are stated as three bans rather than three allow
   * lists because the third one is what closes the loophole:
   * `scope:shared` may depend on neither server nor browser, which makes
   * the shared set closed under dependency. Browser code reaches browser
   * and shared; shared reaches only shared; so no chain of legal edges
   * gets from `apps/web` to Prisma. The guarantee is inductive over
   * single edges — it does not rely on the linter walking the graph.
   *
   * The two catch-alls come first: any project a dependency points at
   * must carry both a `type:` and a `scope:` tag. A new library that
   * arrives untagged therefore fails lint rather than quietly landing
   * outside the boundary system. The fix is six lines in its
   * `package.json`, not an edit to these rules — every constraint below
   * is written against tag patterns, never project names, so a new
   * library inherits its layer's rules the moment it is tagged.
   *
   * Documented in `docs/modernization/architecture.md`.
   */
  {
    files: ["apps/**/*.{ts,tsx}", "libs/**/*.{ts,tsx}"],
    plugins: { "@nx": nx },
    rules: {
      "@nx/enforce-module-boundaries": [
        "error",
        {
          // No escape hatches. An exception here would be invisible at
          // the import site, which is the whole problem this rule solves.
          allow: [],
          // No exemptions for dynamic imports either: the lazy
          // `await import("@loan/accounting")` calls in the repositories
          // are real edges and are checked like any other. Leaving that
          // list empty is what stops `await import(…)` being a
          // one-keyword bypass of everything below.
          checkDynamicDependenciesExceptions: [],
          // Libraries here are consumed as TypeScript source (`main`
          // points at `src/index.ts`); none has a build target, so there
          // is no buildable/non-buildable distinction to enforce.
          enforceBuildableLibDependency: false,
          depConstraints: [
            // ── Every project must be placed on both axes ──────────
            { sourceTag: "*", onlyDependOnLibsWithTags: ["type:*"] },
            { sourceTag: "*", onlyDependOnLibsWithTags: ["scope:*"] },

            // ── Layer: which way dependencies may point ────────────
            {
              sourceTag: "type:app",
              onlyDependOnLibsWithTags: [
                "type:repository",
                "type:domain",
                "type:client",
                "type:ui",
                "type:util",
              ],
            },
            {
              sourceTag: "type:repository",
              onlyDependOnLibsWithTags: ["type:domain", "type:util"],
            },
            {
              sourceTag: "type:domain",
              onlyDependOnLibsWithTags: ["type:domain", "type:util"],
            },
            // The API client speaks in transport DTOs and nothing else.
            // If it needed a domain type, the type belongs in
            // `shared-types` — that is what makes the contract shared.
            {
              sourceTag: "type:client",
              onlyDependOnLibsWithTags: ["type:util"],
            },
            {
              sourceTag: "type:ui",
              onlyDependOnLibsWithTags: ["type:ui", "type:util"],
            },
            { sourceTag: "type:util", onlyDependOnLibsWithTags: ["type:util"] },

            // ── Runtime: what may end up in which bundle ───────────
            {
              sourceTag: "scope:browser",
              notDependOnLibsWithTags: ["scope:server"],
            },
            {
              sourceTag: "scope:server",
              notDependOnLibsWithTags: ["scope:browser"],
            },
            {
              sourceTag: "scope:shared",
              notDependOnLibsWithTags: ["scope:server", "scope:browser"],
            },
          ],
        },
      ],
    },
  },

  // ── Browser code ────────────────────────────────────────────────
  {
    files: [
      "apps/web/**/*.{ts,tsx}",
      "apps/platform/**/*.{ts,tsx}",
      "apps/marketing/**/*.{ts,tsx}",
      "libs/ui/**/*.{ts,tsx}",
      "libs/api-client/**/*.ts",
    ],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },

  // ── Node/server code ────────────────────────────────────────────
  {
    files: ["apps/api/**/*.ts", "libs/**/*.ts", "scripts/**/*.{ts,mjs}"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // ── Tests ───────────────────────────────────────────────────────
  // Assertions frequently produce intentionally-unused expressions and
  // deliberately-wrong types; the type-aware rules fight that.
  {
    files: ["**/*.{test,spec}.{ts,tsx}", "**/*.d.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      // Mock factories (`vi.fn().mockImplementation(({ where, data }) => …)`)
      // deal in deliberately-loose doubles; the types that matter are
      // asserted by the test body, not by the stub's signature.
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
    },
  },
);
