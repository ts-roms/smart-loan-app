/**
 * Static probe target, replacing the `location = /health.txt` block in
 * deploy/railway/nginx.spa.conf.template.
 *
 * The nginx version answered from the web server itself, deliberately,
 * "so 'is the SPA being served' stays separate from 'is the API up' —
 * otherwise an API outage marks the web deploy failed and rolls back a
 * perfectly good frontend."
 *
 * That separation is WEAKER here and it is worth being precise about
 * why. This handler still does not touch the API, so an API outage
 * cannot fail the probe. But nginx answered it from a config directive
 * with no application code in the path, whereas this answers from the
 * same Node process that renders the pages — so a hung render loop or
 * an OOM now fails the healthcheck too. That is arguably more useful
 * and definitely different.
 *
 * `force-static` so it is generated at build time and served from the
 * prerender cache rather than invoking the route handler per probe.
 */
export const dynamic = "force-static";

export function GET() {
  return new Response("ok", {
    headers: { "Content-Type": "text/plain" },
  });
}
