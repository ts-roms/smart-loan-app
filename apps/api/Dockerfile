# syntax=docker/dockerfile:1.7
#
# Fastify API image.
#
# The workspace libs (`@loan/*`) all expose their `src/index.ts` directly
# via package.json — there is no per-lib compile step. Rather than wire
# up tsc + path aliases for runtime resolution, we use `tsx` to run the
# TypeScript source directly. That keeps the image small, the build fast,
# and "what's in dev" the same as "what's in prod."
#
# Build from the REPO ROOT so pnpm sees the workspace:
#   docker build -f apps/api/Dockerfile -t smart-loan-api .

# ── Stage 1: deps + prisma generate ──────────────────────────────────────
FROM node:20-alpine AS builder

RUN corepack enable
RUN apk add --no-cache openssl

WORKDIR /repo

# Manifests first for a cacheable install layer.
# pnpm with --frozen-lockfile validates every workspace package the
# lockfile references — so we must ship every libs/*/package.json,
# even ones the api doesn't directly import.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml nx.json tsconfig.base.json ./
COPY apps/api/package.json              ./apps/api/
COPY apps/web/package.json              ./apps/web/
COPY libs/accounting/package.json       ./libs/accounting/
COPY libs/api-client/package.json       ./libs/api-client/
COPY libs/auth/package.json             ./libs/auth/
COPY libs/credit-scoring/package.json   ./libs/credit-scoring/
COPY libs/db/package.json               ./libs/db/
COPY libs/decisioning/package.json      ./libs/decisioning/
COPY libs/features/package.json         ./libs/features/
COPY libs/jobs/package.json             ./libs/jobs/
COPY libs/kyc/package.json              ./libs/kyc/
COPY libs/loans/package.json            ./libs/loans/
COPY libs/notifications/package.json    ./libs/notifications/
COPY libs/payments/package.json         ./libs/payments/
COPY libs/pdf/package.json              ./libs/pdf/
COPY libs/screening/package.json        ./libs/screening/
COPY libs/shared-types/package.json     ./libs/shared-types/
COPY libs/shared-utils/package.json     ./libs/shared-utils/
COPY libs/ui/package.json               ./libs/ui/

RUN pnpm install --frozen-lockfile

# Source last — invalidates only this layer when code changes
COPY apps/api  ./apps/api
COPY libs      ./libs

# Generates the prisma client into libs/db/node_modules/.prisma
RUN pnpm --filter @loan/db exec prisma generate


# ── Stage 2: runtime ─────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

RUN apk add --no-cache openssl tini

ENV NODE_ENV=production
ENV PATH=/app/node_modules/.bin:$PATH
WORKDIR /app

# Copy everything wholesale from the builder. The image stays small
# because the builder used pnpm's hard-linked store; the resulting
# node_modules trees are mostly symlinks.
COPY --from=builder /repo/package.json              ./package.json
COPY --from=builder /repo/pnpm-workspace.yaml       ./pnpm-workspace.yaml
COPY --from=builder /repo/tsconfig.base.json        ./tsconfig.base.json
COPY --from=builder /repo/node_modules              ./node_modules
COPY --from=builder /repo/apps/api                  ./apps/api
COPY --from=builder /repo/libs                      ./libs

# Persist uploads via a volume; make sure the dir exists and is writable
RUN mkdir -p /app/uploads && chown -R node:node /app/uploads /app
USER node

EXPOSE 3001

# On boot, sync the schema before starting the server:
#  · if migrations exist  → `prisma migrate deploy`  (production-safe)
#  · if not (fresh repo)  → `prisma db push`         (best-effort apply)
# Then run the api via tsx, which hot-resolves @loan/* workspace imports
# and TS on the fly. We invoke prisma by absolute path so `npx` doesn't
# try to fetch a newer copy from the registry at runtime.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "\
  cd /app && \
  if [ -n \"$(ls -A libs/db/prisma/migrations 2>/dev/null)\" ]; then \
    echo '[entrypoint] migrations present → migrate deploy'; \
    /app/libs/db/node_modules/.bin/prisma migrate deploy --schema=libs/db/prisma/schema.prisma; \
  else \
    echo '[entrypoint] no migrations → db push (schema-only sync)'; \
    /app/libs/db/node_modules/.bin/prisma db push --schema=libs/db/prisma/schema.prisma --accept-data-loss; \
  fi && \
  /app/apps/api/node_modules/.bin/tsx /app/apps/api/src/main.ts \
"]
