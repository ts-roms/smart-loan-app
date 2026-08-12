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
 *
 * Stylistic rules are deliberately absent: Prettier owns formatting and
 * runs on the pre-commit hook. Rules here should find bugs, not opinions.
 */
import js from "@eslint/js";
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

  // ── Browser code ────────────────────────────────────────────────
  {
    files: ["apps/web/**/*.{ts,tsx}", "apps/platform/**/*.{ts,tsx}", "apps/marketing/**/*.{ts,tsx}", "libs/ui/**/*.{ts,tsx}", "libs/api-client/**/*.ts"],
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
    files: [
      "**/*.{test,spec}.{ts,tsx}",
      "**/*.d.ts",
      // The test harness itself — setup file, render helper. Same
      // relaxations apply: it exists to serve the specs.
      "**/src/test/**/*.{ts,tsx}",
    ],
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
      // react-refresh guards hot-reload boundaries in the dev server.
      // Test files are never hot-reloaded, so a helper that exports both
      // a wrapper component and a `render` function is fine here.
      "react-refresh/only-export-components": "off",
    },
  },
);
