# Tenant web app → the API's main mount points.
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
