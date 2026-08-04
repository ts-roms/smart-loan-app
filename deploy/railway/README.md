# Deploying SmartLoan on Railway

Three services in one Railway project: **Postgres**, **api**, **web**.

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
to `0.0.0.0`, so it binds whatever Railway assigns.

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

| Variable       | Value                                                           |
| -------------- | --------------------------------------------------------------- |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}`                                    |
| `JWT_SECRET`   | a long random string — generate one, do not reuse the dev value |
| `NODE_ENV`     | `production`                                                    |
| `WEB_ORIGIN`   | the web service's public URL, for CORS                          |
| `UPLOADS_DIR`  | `/home/node/app/uploads`                                        |

`PORT` and `HOST` are deliberately absent — Railway injects `PORT`, and
the config already defaults `HOST` to `0.0.0.0`.

The start command runs `prisma migrate deploy` before the server. It is
idempotent, so it is safe on every boot and on every replica.

### 3. web

- **Source**: this repo
- **Root directory**: `/`
- **Config as code**: `deploy/railway/railway.web.json`

Variables:

| Variable       | Value                                             |
| -------------- | ------------------------------------------------- |
| `API_UPSTREAM` | `http://<api-service-name>.railway.internal:3001` |

The Dockerfile defaults `API_UPSTREAM` to `http://api.railway.internal:3001`,
which is right when the API service is literally named `api`. Set it
explicitly if you named it anything else — a wrong value fails as a 502
from nginx, not as a build error.

nginx resolves this per request rather than at startup, so the web
service boots and serves the SPA even when the API is unreachable;
`/api/v1/*` returns 502 until it comes up. That ordering matters on a
first deploy, where web may well start before api exists — the naive
config crash-loops there instead.

Generate a public domain for this service only. The API does not need
one: the browser talks to it through nginx on the same origin, which is
also why there is no CORS hop to configure between them.

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

The marketing service needs two more variables, and they are build-time:

| Variable            | Value                               |
| ------------------- | ----------------------------------- |
| `VITE_APP_URL`      | the tenant web service's public URL |
| `VITE_PLATFORM_URL` | the platform console's public URL   |

Vite inlines `import.meta.env` when the bundle is compiled, so these
must reach the BUILD, not the running container. `Dockerfile.marketing`
declares them as `ARG`s for exactly that reason — Railway forwards
service variables to declared args. Set them as ordinary service
variables and they arrive. Miss them and the public site ships
`http://localhost:5173` as its "Sign in" link.

They proxy DIFFERENT prefixes, because they talk to different mount
points on the same API (see apps/api/src/app.ts):

| Service   | Proxies                        | API mount                         |
| --------- | ------------------------------ | --------------------------------- |
| web       | `/api/v1`, `/uploads`, `/docs` | `registerRoutes`, at `/api/v1`    |
| platform  | `/platform`                    | `platformRoutes`, at the API root |
| marketing | `/public`                      | `publicRoutes`, at the API root   |

That is why the config is `nginx.spa.conf.template` shared by all three
plus a per-app `proxy-*.inc`: SPA serving, `$PORT` binding, caching and
deferred upstream resolution are identical, only the forwarded prefixes
differ. Each image includes only its own, so the console cannot
accidentally proxy `/api/v1` and the tenant app cannot reach
`/platform`.

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

Two bugs were found and fixed that way. nginx refused to start on an
unresolvable upstream, and the base image's resolver script is opt-in —
without `NGINX_ENTRYPOINT_LOCAL_RESOLVERS` the resolver directive
survived substitution as a literal and killed startup. Both would have
presented on Railway as a crash-looping web service.

The API image is unchanged from the Docker path, which is already
exercised by `deploy/docker/`.

## Verifying a deploy

```
curl -fsS https://<web-domain>/health.txt
curl -fsS https://<web-domain>/api/v1/health
```

The first proves nginx is serving; the second proves the private
networking hop to the API works. If the first passes and the second
returns 502, `API_UPSTREAM` is pointing at the wrong service name.
