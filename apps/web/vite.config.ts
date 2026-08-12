import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { fileURLToPath, URL } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { themeColors } from "./src/theme";

/**
 * Injects theme palette values from `src/theme.ts` into `index.html`
 * at build time so the static HTML head is never out of sync with the
 * runtime palette. Replaces tokens like `%THEME_COLOR_BG%`.
 *
 * Tokens are intentionally NOT Vite's built-in `%ENV_VAR%` syntax —
 * those need an env var, and we want compile-time constants. Plain
 * string replace covers it.
 */
/*
 * Rewrites the root-absolute asset links in index.html to sit under the
 * configured base.
 *
 * Vite rewrites `src="/src/main.tsx"` for us but leaves hand-written
 * `href="/favicon.svg"` alone. Mounted at /app behind the marketing
 * host, those resolve against the ROOT — i.e. the marketing service —
 * and 404. Same reason the manifest's icon srcs are template strings.
 */
function baseAbsoluteLinks(base: string): Plugin {
  return {
    name: "smartloan-base-absolute-links",
    enforce: "post",
    transformIndexHtml(html) {
      if (base === "/") return html;
      return html
        .replace(/href="\/favicon\.svg"/g, `href="${base}favicon.svg"`)
        .replace(/href="\/icons\//g, `href="${base}icons/`);
    },
  };
}

function injectThemeTokens(): Plugin {
  return {
    name: "smartloan-inject-theme-tokens",
    transformIndexHtml(html) {
      return html
        .replace(/%THEME_COLOR_BG%/g, themeColors.background)
        .replace(/%THEME_COLOR_FG%/g, themeColors.foreground)
        .replace(/%THEME_COLOR_PRIMARY%/g, themeColors.primary);
    },
  };
}

/*
 * Content-Security-Policy for the console — the other half of S-2.
 *
 * The API's policy is set by a hook in apps/api/src/app.ts and covers
 * JSON, /docs and /uploads/. It cannot cover this app: the SPA is
 * served by Vite in development and by nginx (or whatever a self-hosting
 * co-op points at apps/web/dist) in production. This is where "injected
 * script in an admin UI rendering customer-supplied strings" actually
 * lands — borrower names, addresses, employers, collection notes and
 * demand-letter bodies render on nearly every screen here.
 *
 * DELIVERED AS <meta>, deliberately. The built artifact is deployed at
 * least four ways — deploy/docker, three Railway images, deploy/bare-metal,
 * and a bare `dist/` on someone's own static host — and only some of
 * those are files this repo controls. A policy that travels inside
 * index.html is enforced on all of them, including the host nobody
 * configured. The nginx configs under deploy/ add `frame-ancestors`
 * as a real header because <meta> cannot express it (the parser ignores
 * it there and logs a warning); that is the only directive split across
 * the two mechanisms.
 *
 * The policy is generated at transform time rather than written out as
 * a literal so the hash of the inline theme script in index.html is
 * always the hash of what actually shipped. Editing that script can
 * therefore never silently break the app — the hash follows it.
 */

/**
 * CSP hash-source for one inline script body.
 *
 * Newlines are normalised to LF FIRST, and that is not cosmetic. The
 * HTML parser rewrites every CRLF and lone CR in a document to a single
 * LF before the script's text ever exists, so the browser hashes the
 * normalised form. index.html is checked out with CRLF endings on
 * Windows, so hashing the bytes on disk produces a hash that matches
 * nothing and silently blocks the anti-FOUC theme script — on Windows
 * only, which is the worst possible way to find out. Observed exactly
 * that before this line existed.
 */
function scriptHash(source: string): string {
  const normalised = source.replace(/\r\n?/g, "\n");
  return `'sha256-${createHash("sha256").update(normalised, "utf8").digest("base64")}'`;
}

/**
 * Hash every inline `<script>` in the document.
 *
 * Two of them exist by the time this runs: the anti-FOUC theme script
 * hand-written in index.html, and — in dev only — the React Refresh
 * preamble that @vitejs/plugin-react injects. Hashing whatever is
 * present beats listing them, because the dev one is not ours to
 * predict and changes with the plugin version.
 *
 * Scripts carrying `src` are skipped: they are fetched, not inline, and
 * `'self'` already covers them.
 */
function inlineScriptHashes(html: string): string[] {
  const inline = /<script(?![^>]*\ssrc[\s=])[^>]*>([\s\S]*?)<\/script>/gi;
  const hashes = new Set<string>();
  for (const [, body] of html.matchAll(inline)) {
    if (body.trim()) hashes.add(scriptHash(body));
  }
  return [...hashes];
}

/*
 * Two runtime dependencies reach off-origin, and both are lazy — the
 * officer who never runs OCR never pays for them, and neither does the
 * policy until they do.
 *
 * tesseract.js (ID OCR) spawns a Worker from a `blob:` URL whose whole
 * body is `importScripts("https://cdn.jsdelivr.net/npm/tesseract.js@v5/...")`,
 * and that worker then pulls its WASM core from the same CDN. A blob:
 * worker inherits the creating document's policy, so the CDN has to be
 * in script-src, not just worker-src. Language data comes from
 * tessdata.projectnaptha.com over fetch, which is connect-src only.
 *
 * This is the weakest part of the policy and it is called out in
 * docs/modernization/security.md: cdn.jsdelivr.net serves any package
 * on npm, so an attacker who has already found an injection point can
 * publish a package and load it from an allowed source. The fix is to
 * self-host tesseract's worker + core and drop the entry; it is not
 * done here because those files are ~15 MB and would have to be kept in
 * step with the dependency by hand.
 */
const OCR_SCRIPT_CDN = "https://cdn.jsdelivr.net";
const OCR_DATA_CDN = "https://tessdata.projectnaptha.com";

function buildPolicy(hashes: string[], dev: boolean): string {
  const directives: Record<string, string[]> = {
    // Nothing loads from anywhere unless a directive below says so.
    "default-src": ["'self'"],
    /*
     * No 'unsafe-inline' and no 'unsafe-eval'. The inline scripts that
     * genuinely exist are allowed by hash; everything else is a bundle
     * fetched from our own origin.
     *
     * 'wasm-unsafe-eval' is required by both browser-local ML features:
     * face-api's TensorFlow backend and tesseract's OCR core are WASM.
     * It permits WebAssembly compilation and nothing else — it is not
     * 'unsafe-eval', and it does not make eval() or new Function() work.
     */
    "script-src": ["'self'", ...hashes, "'wasm-unsafe-eval'", OCR_SCRIPT_CDN],
    /*
     * 'unsafe-inline' for styles, and it is not avoidable here.
     *
     * Checked rather than assumed: Tailwind compiles to a static
     * stylesheet and needs nothing, but Radix positions every popover,
     * dropdown, tooltip and dialog by writing `style="transform: ..."`
     * onto the element, and react-remove-scroll (which Radix's dialogs
     * pull in) injects a <style> element to lock the body. Both are
     * governed by style-src. Removing the keyword blanks out every
     * floating surface in the app.
     *
     * Hashes cannot help — the values are computed per interaction —
     * and a nonce cannot either, because the attribute form is not
     * nonceable. This costs far less than the script equivalent: an
     * attacker who can only inject CSS cannot execute code.
     */
    "style-src": ["'self'", "'unsafe-inline'"],
    /*
     * data: for the inlined SVG icons Vite emits under its 4 KB
     * threshold; blob: for the object URLs the signature pad, the
     * webcam capture and the OCR drop zone create locally.
     *
     * Stored uploads need no entry of their own: every deployment
     * proxies /uploads/ through the same origin as the SPA (see
     * deploy/docker/nginx.web.conf and deploy/railway/proxy-api.inc),
     * so a signed document URL is 'self'.
     */
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'", "data:"],
    // The API is /api/v1 on this same origin — see providers/api.tsx —
    // so 'self' covers it in every deployment.
    "connect-src": ["'self'", OCR_SCRIPT_CDN, OCR_DATA_CDN],
    // Workbox's service worker is same-origin; tesseract's is a blob.
    "worker-src": ["'self'", "blob:"],
    // The only frame in the app is DocumentPreview's PDF viewer, which
    // points at a signed same-origin /uploads/ path.
    "frame-src": ["'self'"],
    "manifest-src": ["'self'"],
    "media-src": ["'self'", "blob:"],
    // No <object>/<embed> anywhere, and they are a legacy script vector.
    "object-src": ["'none'"],
    // Nothing may repoint relative URLs, and no form in this app posts
    // anywhere but back to its own origin — every mutation goes through
    // fetch, so 'self' is already more than is used.
    "base-uri": ["'none'"],
    "form-action": ["'self'"],
    // frame-ancestors is NOT here: <meta> cannot carry it. It is set as
    // a header by the nginx configs under deploy/.
  };

  if (dev) {
    /*
     * The one dev/production difference, and it only widens
     * connect-src: Vite's HMR client opens a websocket back to the dev
     * server, and 'self' does not cover a ws:// URL because the scheme
     * makes it a different origin.
     *
     * Everything else — including the script hashes — is identical, on
     * purpose. A policy that is only enforced in production is a policy
     * whose first real test is a production incident.
     */
    directives["connect-src"].push("ws:", "wss:");
  }

  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(" ")}`)
    .join("; ");
}

function contentSecurityPolicy(): Plugin {
  let dev = false;
  return {
    name: "smartloan-csp",
    enforce: "post",
    configResolved(config) {
      dev = config.command === "serve";
    },
    transformIndexHtml: {
      // `post` so the hashes are taken from the final document: the
      // React Refresh preamble is injected by an earlier hook, and a
      // hash computed before it lands would not match it.
      order: "post",
      handler(html) {
        return {
          html,
          tags: [
            {
              tag: "meta",
              attrs: {
                "http-equiv": "Content-Security-Policy",
                content: buildPolicy(inlineScriptHashes(html), dev),
              },
              // Must precede everything it governs — a <meta> CSP does
              // not apply to scripts the parser has already run.
              injectTo: "head-prepend",
            },
          ],
        };
      },
    },
  };
}

// Resolve `@/*` to apps/web/src/* — matches the path alias in tsconfig.json
// so feature imports look like `from '@/features/loans'` from anywhere.
/*
 * Where this app is mounted, as a build-time constant.
 *
 * Deployed, the tenant app sits under /app on the shared hostname —
 * marketing owns the root. Locally it stays at / so `pnpm dev` and the
 * e2e flows are unchanged.
 *
 * ONE value feeds Vite's `base`, the router's basename (via
 * import.meta.env.BASE_URL) and the PWA's scope/start_url/fallback.
 * They have to agree: a service worker whose scope doesn't match the
 * page it controls silently stops controlling it, and a navigateFallback
 * outside the base serves the wrong document — both failure modes this
 * app has already been bitten by.
 */
const BASE = process.env.APP_BASE_PATH ?? "/";

export default defineConfig({
  base: BASE,
  plugins: [
    react(),
    injectThemeTokens(),
    baseAbsoluteLinks(BASE),
    /*
     * PWA — makes SmartLoan installable (desktop icon, standalone
     * window, splash screen). Auto-update strategy: the service worker
     * polls for new builds and prompts the user to refresh.
     *
     * We DELIBERATELY don't cache API responses by default — financial
     * data must always be fresh. The runtimeCaching block below uses a
     * NetworkFirst policy for static assets only, and SKIPS auth +
     * mutation endpoints entirely so a stale SW can't serve a stale
     * JWT or an outdated loan balance.
     *
     * Set `disable: true` here when working on the service worker to
     * stop the registration loop in dev (Vite handles HMR; the SW
     * sometimes fights it). Keep the manifest enabled either way so
     * the installable affordance still renders.
     */
    VitePWA({
      registerType: "prompt",
      includeAssets: ["favicon.svg", "robots.txt"],
      manifest: {
        name: "SmartLoan",
        short_name: "SmartLoan",
        description:
          "Advanced loan management for Philippine cooperatives — origination, KYC, decisioning, collections, accounting.",
        // Sourced from src/theme.ts so the PWA manifest, the
        // `<meta name="theme-color">` tag, and the runtime CSS all
        // resolve to the same brand colour.
        theme_color: themeColors.background,
        background_color: themeColors.background,
        display: "standalone",
        orientation: "any",
        // Start at root so the installed app drops the user on the
        // dashboard (or login if not signed in).
        start_url: BASE,
        scope: BASE,
        // Edge / Chrome show the description + screenshots when
        // promoting the install banner. Keeping it lean for now.
        categories: ["finance", "business", "productivity"],
        // Using SVG icons for now: Chrome / Edge / Brave / Firefox accept
        // them; iOS Safari uses the apple-touch-icon link in index.html.
        // To upgrade to raster PNGs (best practice for full Android +
        // iOS install affordance) run `pnpm dlx @vite-pwa/assets-generator`
        // against public/icons/icon.svg — that produces 192/512/maskable
        // PNGs and you swap the entries below to image/png.
        icons: [
          {
            src: `${BASE}icons/icon.svg`,
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any",
          },
          {
            src: `${BASE}icons/icon-maskable.svg`,
            sizes: "any",
            type: "image/svg+xml",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // Precache everything the build emits, but skip the model files
        // for face-api / OCR — they're large (>2MB each), best fetched
        // lazily on first use, and don't need to be available offline.
        globPatterns: ["**/*.{js,css,html,svg,ico,woff2}"],
        globIgnores: ["models/**", "assets/face-api*"],
        // 5 MB cap per asset — face-api ships a 1.3 MB chunk that
        // would exceed Workbox's default 2 MB ceiling otherwise.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        /*
         * SPA navigation fallback — MUST be the app shell.
         *
         * Workbox serves this for EVERY navigation request the service
         * worker handles, not only ones the network refuses. Pointing it
         * at offline.html meant that once the SW installed, every reload
         * and every deep link rendered "You're offline" — online,
         * offline, didn't matter. Installing the PWA bricked the app.
         *
         * index.html is precached, so it also loads with no network at
         * all; React then boots and can show its own offline state.
         * offline.html stays precached as the pre-install cold-start
         * fallback, but it is deliberately NOT the navigation target.
         */
        navigateFallback: `${BASE}index.html`,
        // Never hand API or upload requests the HTML shell — they must
        // fail as requests so the client's error handling sees them.
        navigateFallbackDenylist: [/^\/api\//, /^\/uploads\//],
        runtimeCaching: [
          {
            // Static images / fonts from our own origin — cache-first
            // is fine; they're content-addressed.
            urlPattern: /\.(?:png|jpg|jpeg|svg|webp|woff2)$/,
            handler: "CacheFirst",
            options: {
              cacheName: "smartloan-assets",
              expiration: {
                maxEntries: 200,
                maxAgeSeconds: 7 * 24 * 60 * 60, // 7 days
              },
            },
          },
          {
            // Read-only GETs to safe-to-cache endpoints — NetworkFirst
            // with a 3-second timeout so users on flaky connections
            // get *something* rather than a spinner. Explicit allowlist
            // (NOT a blanket /api/v1/ rule) so we never accidentally
            // cache auth or write-side endpoints.
            urlPattern: /^\/api\/v1\/(loan-products|help)\b/,
            handler: "NetworkFirst",
            options: {
              cacheName: "smartloan-config",
              networkTimeoutSeconds: 3,
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 }, // 1h
            },
          },
        ],
        // Auto-claim clients so an updated SW takes effect immediately
        // (after the user accepts the update prompt).
        clientsClaim: true,
        skipWaiting: false,
      },
      devOptions: {
        // Easier to test SW behaviour locally — but expect Vite HMR
        // to fight with it sometimes. Turn off if it gets annoying.
        enabled: false,
      },
    }),
    // Last, so the hashes it takes cover every inline script the
    // plugins above have finished injecting.
    contentSecurityPolicy(),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    /*
     * 127.0.0.1, not "localhost".
     *
     * The API binds config.host, which is 0.0.0.0 — IPv4 only. On a
     * dual-stack machine Node resolves "localhost" to ::1 FIRST, so the
     * proxy would reach whatever holds the IPv6 half of :3001. That is
     * not hypothetical: another project's dev server took [::]:3001 and
     * every proxied call — login included — came back 404 from a server
     * that had never heard of this API. Pinning the family makes the
     * proxy hit our API or nothing at all, which fails honestly.
     */
    proxy: {
      "/api": { target: "http://127.0.0.1:3001", changeOrigin: true },
      "/uploads": { target: "http://127.0.0.1:3001", changeOrigin: true },
    },
  },
});
