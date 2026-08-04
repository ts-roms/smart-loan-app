# Deploying SmartLoan on Railway

Three services in one Railway project: **Postgres**, **api**, **web** —
plus **marketing** and **platform** if you are hosting the vendor
surfaces too, in which case marketing is what carries the public domain.

This is the vendor-hosted path. It is not a replacement for
[`docker/`](../docker/README.md) or [`bare-metal/`](../bare-metal/README.md),
which are what a cooperative runs on its own hardware — the on-prem
story in the main deploy README still holds.

## Why the web service has its own Dockerfile

`deploy/docker/Dockerfile.web` cannot run on Railway unchanged, for two
reasons that both come down to Railway deciding things at deploy time:

|             | compose                                   | Railway                                           |
| ----------- | ----------------------------------------- | ------------------------------------------------- |
| Port        | nginx `listen 80`, published as `8080:80` | a `$PORT` per deploy that the container must bind |
| API address | `http://api:3001` over the compose bridge | private DNS, `<service>.railway.internal`         |

So `deploy/railway/Dockerfile.web` templates both. The API image needs
no such treatment — `config.ts` already reads `PORT` and defaults `HOST`
to `::`, so it binds whatever Railway assigns.

## Everything is one origin

The public surface is a single hostname. Marketing owns the root and
forwards `/app/` to the web service:

```
https://your-domain/            marketing   (this service's own files)
https://your-domain/app/        web         → proxied to the web service
https://your-domain/api/v1/…    api         ┐
https://your-domain/public/…    api         ├ proxied to the api service
https://your-domain/uploads/…   api         ┘
```

The platform console stays on its own domain. It is a vendor surface,
not a tenant one, and there is no reason for a cooperative's members to
be able to reach it by guessing a path.

Two consequences worth knowing before you change anything:

- **The web app is built for its mount point.** `APP_BASE_PATH` is a
  BUILD arg, because Vite bakes the prefix into every emitted URL. An
  app built for `/` and served at `/app/` requests its bundles from the
  wrong place and shows a blank page.
- **Only marketing needs a public domain.** Giving web its own as well
  is fine for debugging — it serves the app at `/app/` there too — but
  it means the app answers on two URLs, and a PWA installed from one is
  a different install from the other.

### Private networking is IPv6-only

Railway's `<service>.railway.internal` addresses resolve to IPv6 only.
A service bound to `0.0.0.0` still answers public traffic through
Railway's edge and reports healthy, while every proxy hop from another
service is refused. Both sides of this are handled — nginx has a
`listen [::]:${PORT}` alongside the v4 one, and the API defaults `HOST`
to `::` (dual-stack, so it still accepts v4) — but it is the first thing
to check if a proxied prefix 502s while the upstream looks fine.

## Setup

### 1. Postgres

Add the Postgres database from Railway's service catalogue. It exposes
`DATABASE_URL` on the project, which the api service references below.

### 2. api

- **Source**: this repo
- **Root directory**: `/` — the Dockerfile copies `apps/` and `libs/`,
  so it needs the whole workspace as build context
- **Config as code**: `deploy/railway/railway.api.json`

Variables:

| Variable           | Value                                                                 |
| ------------------ | --------------------------------------------------------------------- |
| `DATABASE_URL`     | `${{Postgres.DATABASE_URL}}`                                          |
| `JWT_SECRET`       | a long random string — generate one, do not reuse the dev value       |
| `NODE_ENV`         | `production`                                                          |
| `WEB_ORIGIN`       | the public domain, for CORS                                           |
| `MARKETING_ORIGIN` | the public domain — it is what the signup confirmation email links to |
| `UPLOADS_DIR`      | `/home/node/app/uploads`                                              |

`WEB_ORIGIN` and `MARKETING_ORIGIN` are now the SAME value, since both
sites live on one hostname. Nothing is same-origin from the API's point
of view, though — it never sees the browser directly, only nginx — so
these still have to be right: `MARKETING_ORIGIN` is pasted into an email
a human clicks, and a stale one sends new cooperatives to a dead link.

`PORT` and `HOST` are deliberately absent — Railway injects `PORT`, and
the config already defaults `HOST` to `::`.

The start command runs `prisma migrate deploy` before the server. It is
idempotent, so it is safe on every boot and on every replica.

### 3. web

- **Source**: this repo
- **Root directory**: `/`
- **Config as code**: `deploy/railway/railway.web.json`

Variables:

| Variable        | Value                                             |
| --------------- | ------------------------------------------------- |
| `API_UPSTREAM`  | `http://<api-service-name>.railway.internal:3001` |
| `APP_BASE_PATH` | `/app/` — build-time, trailing slash required     |

`APP_BASE_PATH` is where the app is mounted on the public origin. It has
to reach the BUILD: Vite inlines it into every asset URL, the PWA
manifest's `start_url` and `scope`, the service worker's navigation
fallback, and the router's basename — all from the one constant in
`apps/web/vite.config.ts`. A runtime service variable arrives long after
the bundle is written. `Dockerfile.web` declares it as an `ARG`, which
Railway forwards service variables to automatically.

Changing it later invalidates any installed PWA, because `scope` moves.

The Dockerfile defaults `API_UPSTREAM` to `http://api.railway.internal:3001`,
which is right when the API service is literally named `api`. Set it
explicitly if you named it anything else — a wrong value fails as a 502
from nginx, not as a build error.

nginx resolves this per request rather than at startup, so the web
service boots and serves the SPA even when the API is unreachable;
`/api/v1/*` returns 502 until it comes up. That ordering matters on a
first deploy, where web may well start before api exists — the naive
config crash-loops there instead.

Generate a public domain on the MARKETING service, not this one — see
"Everything is one origin" above. The API never needs one: the browser
talks to it through nginx, which is also why there is no CORS hop to
configure between them.

## Uploads do not survive a redeploy

The API writes KYC documents and signatures to `UPLOADS_DIR` on the
container filesystem, which Railway replaces on every deploy.

Attach a volume to the api service mounted at `/home/node/app/uploads`
before storing anything you need to keep. Without one, uploads work
until the next deploy and then quietly disappear — the records still
reference files that are gone.

## Health checks

| Service | Path             | Answered by                                                    |
| ------- | ---------------- | -------------------------------------------------------------- |
| api     | `/api/v1/health` | Fastify. Note the `/api/v1` prefix — a bare `/health` is a 404 |
| web     | `/health.txt`    | nginx directly                                                 |

The web probe deliberately does not proxy to the API. If it did, an API
outage would fail the web service's healthcheck and roll back a
perfectly good frontend deploy.

### 4. platform and marketing (optional, vendor-side)

Same shape as the web service — a Dockerfile each, `Config as code` at
`deploy/railway/railway.platform.json` / `railway.marketing.json`, root
directory `/`, and `API_UPSTREAM` pointing at the API.

These are vendor-side apps, not part of a cooperative's install. Deploy
them only if you are hosting the vendor surfaces too.

Marketing is the public edge, so it carries the domain and needs three
more variables:

| Variable            | Value                                             |
| ------------------- | ------------------------------------------------- |
| `WEB_UPSTREAM`      | `http://<web-service-name>.railway.internal:8080` |
| `VITE_APP_URL`      | `/app` — build-time, NO trailing slash            |
| `VITE_PLATFORM_URL` | the platform console's public URL, build-time     |

`VITE_APP_URL` is a prefix that `/login` and `/register` get appended
to, so `/app` yields `/app/login`. It takes an absolute URL too, if you
would rather run the app on its own hostname.

Vite inlines `import.meta.env` when the bundle is compiled, so the two
`VITE_` ones must reach the BUILD, not the running container.
`Dockerfile.marketing` declares them as `ARG`s for exactly that reason —
Railway forwards service variables to declared args. Set them as
ordinary service variables and they arrive. Miss them and the public
site ships `http://localhost:5173` as its "Sign in" link.

`WEB_UPSTREAM`, by contrast, is read at container start, and the port in
it is the one nginx binds INSIDE the web container (`ENV PORT` in
`Dockerfile.web`, 8080) — not the public 443.

### Which service proxies what

The three images proxy different prefixes, because they talk to
different mount points on the same API (see `apps/api/src/app.ts`):

| Service   | Proxies                                           | Provided by              |
| --------- | ------------------------------------------------- | ------------------------ |
| web       | `/api/v1`, `/uploads`, `/docs`                    | `proxy-api.inc`          |
|           | `/app/` → strips the prefix, serves its own files | `proxy-web.inc`          |
| platform  | `/platform`                                       | `proxy-platform.inc`     |
| marketing | `/api/v1`, `/uploads`, `/docs`                    | `proxy-api.inc`          |
|           | `/public`                                         | `proxy-marketing.inc`    |
|           | `/app/` → the web service                         | `proxy-app.inc.template` |

Marketing includes `proxy-api.inc` because it owns the root domain: the
app mounted at `/app` calls `/api/v1/...` root-absolute, so those land
on marketing rather than on the web service.

`proxy-web.inc` strips the base path instead of the files being moved
under `/app/` in the image. That keeps the document root the same shape
however the app was built, so `location /assets/` and the SPA fallback
in the shared template need no knowledge of the mount point — and it
makes the web service behave identically whether it is reached through
the marketing edge or on its own domain.

That split is also why the config is `nginx.spa.conf.template` shared by
all three plus per-app `proxy-*.inc` files: SPA serving, `$PORT`
binding, caching and deferred upstream resolution are identical, only
the forwarded prefixes differ. Each image includes only its own, so the
console cannot accidentally proxy `/api/v1` and the tenant app cannot
reach `/platform`.

## What was tested locally

The web image was built and run against the real API before this landed:

| Check                                          | Result                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| Template renders `${PORT}` / `${API_UPSTREAM}` | substituted; nginx's own `$uri`, `$host`, `$proxy_add_x_forwarded_for` left intact     |
| Boot with an unresolvable upstream             | container stays up, `/health.txt` 200, SPA 200, `/api/v1/*` 502                        |
| All three images build and serve               | web, platform and marketing: `/health.txt` 200, SPA 200                                |
| Per-app proxy isolation                        | platform `/platform/tenants` → 401 from the API; its `/api/v1/*` falls back to the SPA |
| Proxy against a live API                       | `/api/v1/health` identical through nginx and direct                                    |
| Path doubling                                  | a 404 body reports `/api/v1/nope-not-a-route`, not `/api/v1/api/v1/...`                |
| SPA deep link                                  | `/loans/LN-2026-000001` falls back to index.html                                       |
| Caching                                        | index.html `no-store`, hashed assets `immutable`                                       |

The `/app` mount was verified the same way, serving a real
`APP_BASE_PATH=/app/` build through the web image's assembled config:

| Check                          | Result                                                                                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Build derives every URL        | manifest `start_url` + `scope`, `sw.js` fallback, `index.html` links, favicon and PWA icons all `/app/`, with no root-absolute references left |
| `/app` without the slash       | 301 to `/app/`                                                                                                                                 |
| Deep link                      | `/app/loans/LN-2026-000001` → index.html                                                                                                       |
| Rewrite keeps the cache policy | `/app/assets/…` served `max-age=31536000`, i.e. `last` re-enters the immutable block rather than the SPA fallback                              |
| Prefix precision               | `/apple-touch-icon.png` is NOT captured by the `/app` blocks                                                                                   |
| Root build unaffected          | with no `APP_BASE_PATH`, `start_url` and `scope` stay `/`                                                                                      |
| Both configs parse             | `nginx -t` on the marketing and web images' assembled configs                                                                                  |

Two bugs were found and fixed that way. nginx refused to start on an
unresolvable upstream, and the base image's resolver script is opt-in —
without `NGINX_ENTRYPOINT_LOCAL_RESOLVERS` the resolver directive
survived substitution as a literal and killed startup. Both would have
presented on Railway as a crash-looping web service.

The API image is unchanged from the Docker path, which is already
exercised by `deploy/docker/`.

## Verifying a deploy

```
curl -fsS https://<domain>/health.txt
curl -fsS https://<domain>/api/v1/health
curl -fsS -o /dev/null -w '%{http_code}\n' https://<domain>/app/
```

The first proves nginx is serving; the second proves the private
networking hop to the API works; the third proves the hop to the web
service does.

| Symptom                             | Cause                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------- |
| 1 passes, 2 is 502                  | `API_UPSTREAM` names the wrong service                                                      |
| 1 and 2 pass, 3 is 502              | `WEB_UPSTREAM` names the wrong service or the wrong port                                    |
| 3 is 200 but the page renders blank | web was built without `APP_BASE_PATH`, so its bundles are requested from `/assets/` and 404 |
