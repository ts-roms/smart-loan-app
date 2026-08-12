# Security

Living reference. Point-in-time findings: `security-audit.md`.

---

## Controls in place

| Control                  | Implementation                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------- |
| Password hashing         | **argon2id** — not bcrypt, not PBKDF2                                                 |
| Tokens                   | JWT access + refresh, rotated on use                                                  |
| Refresh re-use detection | presenting an already-revoked token revokes the whole family — the theft signal       |
| Session revocation       | `User.sessionsRevokedAt` cutoff enforced in `authenticate`                            |
| Account disable          | `User.active`, checked at login **and** refresh; deactivating also cuts live sessions |
| 2FA                      | TOTP with single-use recovery codes                                                   |
| Authorization            | permission keys resolved from DB role assignments; `requirePermission` per route      |
| Delegation               | time-bound via `expiresAt`, filtered at permission-resolution time                    |
| Rate limiting            | global, plus a tighter per-route limit on `/auth/login`                               |
| Headers                  | helmet                                                                                |
| CORS                     | origin pinned to `config.webOrigin`, credentials enabled                              |
| Audit                    | append-only; impersonation attributes both the tenant user and the platform operator  |
| Tenant isolation         | schema-per-tenant, with a dedicated test                                              |

Backend authorization is authoritative everywhere inspected. UI gates mirror the
endpoint's exact permission key and are never the only gate.

## Open items

**S-1 (P1) — uploads on local disk.** `config.uploadsDir`, served by a static
plugin on the same process. KYC identity documents — government IDs, payslips,
selfies — live on the API container's filesystem.

**Correction (11 Aug 2026):** the Phase 0 audit claimed this included "no
signed-URL expiry". That was wrong, and it was wrong because I asserted it
without reading `uploads/signing.ts`. Signed access **does** exist: a protected
path needs `?exp=<unix-ms>&sig=<hmac>`, minted through an authenticated
endpoint, and `static.plugin.ts` enforces it on every request — 401 on expiry,
403 on a bad signature. The module's own header is candid about what that does
and does not buy: it closes the anonymous hole, but any authenticated caller can
sign any path, so it is not an ownership model.

What remains true, and is the real gap:

|                                |                                                                       |
| ------------------------------ | --------------------------------------------------------------------- |
| Access control                 | ✅ HMAC + expiry, enforced                                            |
| Durability                     | ❌ one container filesystem                                           |
| Backup                         | ⚠️ now covered by `UPLOADS_DIR` in `backup.sh`, but only if it is set |
| Horizontal scaling             | ❌ a second API process cannot read the first's files                 |
| Lifecycle / retention on blobs | ❌                                                                    |

Object storage remains the structural answer (roadmap 3.1), but it is no longer
urgent for _access_, only for durability and scale.

**S-2 — CSP. Closed 12 Aug 2026 for the API; the SPA followed the same day.**

`helmet` still registers with `contentSecurityPolicy: false`, deliberately: one
global policy cannot serve three kinds of response. The policy is set by hook
instead.

| Path            | Policy                                                                            | Why                                             |
| --------------- | --------------------------------------------------------------------------------- | ----------------------------------------------- |
| `/uploads/`     | `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox`    | Nothing served here may execute — see below     |
| `/docs`         | none                                                                              | Swagger UI is a real HTML app and needs scripts |
| everything else | `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` | It is all JSON, so it needs no sources at all   |

The one that matters is `/uploads/`. `store.ts` already keeps `.svg` out of
every borrower-writable subdir and explains why — uploads are served
**same-origin**, so navigating directly to a stored SVG executes any script in
it. That left `branding`, which is admin-writable and, unlike the rest,
**public**: no signature is required, because the logo renders on the login
screen before anyone holds a token. An admin-planted SVG on an unauthenticated
path is a smaller hole than a borrower-planted one, and it is the same hole.

`sandbox` closes it. A sandboxed response is its own opaque origin with
scripting off, so the file renders and cannot reach the session that opened it.
It governs **direct navigation** — the vector — and not `<img src>`, so the
branding panel and every document preview are unaffected. Verified in the
browser: uploads still render, no violations logged.

### The SPA half

`apps/web` is where "injected script in an admin UI rendering customer-supplied
strings" actually lands — borrower names, addresses, employer, collection notes
and demand-letter bodies render on nearly every screen. The API's hook cannot
reach it: the console is served by Vite in development and by nginx in
production.

The policy is generated by a Vite plugin in `apps/web/vite.config.ts` and shipped
as a `<meta http-equiv>` in `index.html`. What ships today:

```
default-src 'self';
script-src 'self' 'sha256-LQM9TPi3SNETZaP4+Xtcw3VsVhVfxTrh7JRwhC8noOI='
           'wasm-unsafe-eval' https://cdn.jsdelivr.net;
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self' data:;
connect-src 'self' https://cdn.jsdelivr.net https://tessdata.projectnaptha.com;
worker-src 'self' blob:; frame-src 'self'; manifest-src 'self';
media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'
```

**Why `<meta>` and not a host header.** The build artifact is deployed at least
four ways — `deploy/docker`, three Railway images, `deploy/bare-metal`, and a
bare `dist/` on a co-op's own static host — and only some are files this repo
controls. A policy inside `index.html` is enforced on all of them, including the
host nobody configured. The one directive `<meta>` cannot express is
`frame-ancestors`; that is a real header, added by all three nginx configs under
`deploy/`. Two policies on one response intersect, so the split loosens nothing.

Dev and production differ by exactly one entry: `connect-src` gains `ws: wss:`
so Vite's HMR socket connects. Everything else, hashes included, is identical —
the strict policy is the one exercised every day, not one whose first real test
is a production incident.

**`script-src` avoided `'unsafe-inline'`; `style-src` could not.** The one inline
script that genuinely exists — the anti-FOUC theme setter in `index.html` — is
allowed by hash, computed from the emitted document so editing it can never
silently break the app. Styles are a different story, and it was checked rather
than assumed: with `style-src 'self'` the console logs violations on first
paint. Radix positions every popover, dropdown, tooltip and dialog by writing a
`style` attribute, and `react-remove-scroll` injects a `<style>` element to lock
the body. Neither is hashable (values are computed per interaction) or
nonceable (the attribute form has no nonce). Tailwind itself needs nothing — it
compiles to a static stylesheet. An attacker who can inject only CSS cannot
execute code, so this is a far cheaper concession than the script equivalent.

**Verified in the browser**, dev and production build, logged in as an admin:
ten routes swept with no violations; uploaded KYC images still render through
the same-origin `/uploads/` proxy; Radix surfaces still position; WebAssembly
still compiles; a `blob:` Worker (tesseract's shape) and a same-origin Worker
both start while one from another origin is refused. Then the inverse — an
injected inline `<script>`, an injected `<script src>` from another origin, an
inline `onclick`, and a `fetch()` to another origin are all blocked, and framing
the app cross-origin is refused by `frame-ancestors`.

**Still open on the SPA:**

- **`cdn.jsdelivr.net` is in `script-src`, and it is the weakest thing here.**
  `tesseract.js` spawns its OCR worker from a `blob:` whose body is
  `importScripts(...)` against jsdelivr, then pulls its WASM core from the same
  host; a `blob:` worker inherits the document's policy, so the CDN cannot be
  confined to `worker-src`. jsdelivr serves any package on npm, so an attacker
  who already has an injection point can publish one and load it from an
  allowed source. The fix is to self-host tesseract's worker and core and drop
  the entry — not done here because those files are ~15 MB and would have to be
  kept in step with the dependency by hand.
- **`apps/marketing` and `apps/platform` have no `<meta>` policy.** They get
  `frame-ancestors` from the shared nginx template and nothing else. The
  platform console is operator-facing and deserves the same treatment.
- **No `report-uri`/`report-to`.** Violations are visible in a browser console
  and nowhere else, so a policy that breaks for a real user is silent.

While adding the header, a latent bug surfaced in all three nginx configs:
nginx does not merge `add_header` across levels, so a `location` declaring even
one of its own inherits **none** from the server block. Every config declared
`Cache-Control` inside `location /`, which meant the `X-Frame-Options: DENY`,
`nosniff` and `Referrer-Policy` written at server level had never once reached
`index.html`. Confirmed by serving the built app through the pre-change config:
the app shell came back with `Cache-Control` and nothing else. The headers are
now repeated in the locations that need them.

**S-3 (P2) — secrets management undocumented.** Configuration flows through
`.env`. Adequate for self-hosted single-tenant, thin for the multi-tenant
platform story.

**S-4 (P3) — no automated dependency scanning** observed in CI.

## Audit trail — §56

Recorded today: `action`, `actorId`, `targetType`, `targetId`, `payload`,
`createdAt`, and the impersonating platform operator where applicable.
Append-only; no update path exists.

**Not yet recorded:** `request_id`, `ip_address`, `user_agent`. §56 lists all
three. Fastify already generates a request id, so adding them is mechanical and
would make the trail materially more useful during an incident.

## The rule for new work

Never trust a frontend check, and never let a service-layer check be the only
one. The borrower portal calls repositories **directly**, bypassing the workflow
services — which is why the erased-customer and archived-customer guards are
implemented at _both_ layers. A guard that exists only in a service protects
only the doors that service owns.
