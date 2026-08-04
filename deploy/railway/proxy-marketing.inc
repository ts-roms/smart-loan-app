# Marketing site → publicRoutes, mounted at /public on the API root.
# This is the unauthenticated surface: lead capture and the two-step
# cooperative signup. Mirrors apps/marketing/vite.config.ts.
location /public/ {
    proxy_pass $api_upstream;
    proxy_http_version 1.1;
}
