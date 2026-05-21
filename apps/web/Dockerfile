# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the React + Vite PWA.
# Stage 1: pnpm install + vite build → static assets in /repo/apps/web/dist
# Stage 2: nginx:alpine serving those assets and proxying /api and /uploads
#          to the `api` service over the docker network.
#
# Build from the REPO ROOT so pnpm can see the workspace:
#   docker build -f apps/web/Dockerfile -t smart-loan-web .

# ── Stage 1: builder ─────────────────────────────────────────────────────
FROM node:20-alpine AS builder

RUN corepack enable

WORKDIR /repo

# Copy workspace manifests first for cacheable install.
# pnpm --frozen-lockfile validates every workspace package the lockfile
# references — so we must ship every libs/*/package.json, even ones the
# web app doesn't directly import.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml nx.json tsconfig.base.json ./
COPY apps/api/package.json              ./apps/api/
COPY apps/web/package.json              ./apps/web/
COPY libs/api-client/package.json       ./libs/api-client/
COPY libs/auth/package.json             ./libs/auth/
COPY libs/credit-scoring/package.json   ./libs/credit-scoring/
COPY libs/db/package.json               ./libs/db/
COPY libs/features/package.json         ./libs/features/
COPY libs/kyc/package.json              ./libs/kyc/
COPY libs/loans/package.json            ./libs/loans/
COPY libs/shared-types/package.json     ./libs/shared-types/
COPY libs/shared-utils/package.json     ./libs/shared-utils/
COPY libs/ui/package.json               ./libs/ui/

RUN pnpm install --frozen-lockfile

# Source — invalidates only this layer when app code changes
COPY apps/web   ./apps/web
COPY libs       ./libs

RUN pnpm --filter @loan/web build


# ── Stage 2: nginx ───────────────────────────────────────────────────────
FROM nginx:alpine AS runtime

LABEL org.opencontainers.image.title="smart-loan-web"
LABEL org.opencontainers.image.description="Smart Loan management system - React PWA served by nginx"
LABEL org.opencontainers.image.licenses="Proprietary"

# Drop the default site, install our SPA-aware one
RUN rm /etc/nginx/conf.d/default.conf
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf

# Vite builds to dist/ by default
COPY --from=builder /repo/apps/web/dist /usr/share/nginx/html

EXPOSE 80

# Container-native health check — fetches the SPA shell to verify nginx
# is serving and the bundle is intact.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://localhost/ || exit 1

# nginx:alpine ships with a proper signal-aware entrypoint already
