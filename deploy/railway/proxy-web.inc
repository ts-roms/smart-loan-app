# Serve the SPA under its base path as well as at the root.
#
# When the image is built with APP_BASE_PATH=/app/, every URL the
# browser derives from the bundle — assets, manifest, sw.js, and every
# route the router pushes — is prefixed with /app/. The FILES, though,
# are still laid out at the document root: Vite's `base` only rewrites
# the references, not the output tree.
#
# Stripping the prefix here rather than moving the files means the
# document root is the same shape regardless of how the image was built,
# so nothing else in nginx.spa.conf.template has to know about the base
# path — `location /assets/` and the SPA fallback keep matching.
#
# `last`, not `break`: it restarts location matching against the
# rewritten URI, which is what lets /app/assets/x.js land in the
# immutable-cache block instead of the fallback.
#
# This also keeps the web service usable on its own Railway domain for
# debugging, not just behind the marketing edge — both spell the app the
# same way.
#
# Unconditional on purpose. With a root build nothing requests /app/ in
# the first place, so there is no case to make it depend on the build
# arg — and a config that varies by build arg is one more thing that can
# be wrong in only one environment.
location = /app {
    return 301 /app/;
}

location /app/ {
    rewrite ^/app/(.*)$ /$1 last;
}
