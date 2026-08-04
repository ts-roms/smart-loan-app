# The API's main mount points, forwarded to the api service.
#
# Included by BOTH the web image and the marketing image. Marketing needs
# it because it owns the root domain: the SPA mounted at /app calls
# `/api/v1/...` — root-absolute, see apps/web/src/providers/api.tsx — so
# those requests arrive at marketing, not at the web service. Serving the
# API from the root of the single public origin is also what keeps the
# stored /uploads/... URLs resolvable without rewriting them.
#
# No URI part on any proxy_pass, deliberately. With a literal upstream
# nginx replaces the matched location prefix; with a VARIABLE upstream
# it doesn't, and mixing the two forms is how you end up serving
# /api/v1/api/v1/... The paths are identical on both sides, so passing
# the original URI through is both simpler and correct.
location /api/v1/ {
    proxy_pass $api_upstream;
    proxy_http_version 1.1;
    # Long enough for a bulk import or a PDF render.
    proxy_read_timeout 120s;
}

location /uploads/ {
    proxy_pass $api_upstream;
    proxy_http_version 1.1;
}

location /docs {
    proxy_pass $api_upstream;
    proxy_http_version 1.1;
}
