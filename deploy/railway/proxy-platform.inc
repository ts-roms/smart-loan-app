# Platform console → platformRoutes, mounted at /platform on the API
# root (NOT under /api/v1 — see app.ts). Mirrors the dev proxy in
# apps/platform/vite.config.ts so the console behaves the same deployed
# as it does locally.
location /platform/ {
    proxy_pass $api_upstream;
    proxy_http_version 1.1;
    proxy_read_timeout 120s;
}
