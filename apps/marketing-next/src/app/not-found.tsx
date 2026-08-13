import Link from "next/link";

/**
 * The `<Route path="*">` case from apps/marketing/src/App.tsx.
 *
 * Behaviour change, and it is an improvement: the react-router version
 * rendered this markup with an HTTP 200, because the server had already
 * served index.html for the unknown path and only the client knew it
 * was a miss. `not-found.tsx` is served with a real 404, which is what
 * a crawler needs in order to drop a dead URL.
 */
export default function NotFound() {
  return (
    <div className="p-20 text-center">
      <h1>Not found</h1>
      <p className="text-fg-dim">
        <Link href="/">← Back home</Link>
      </p>
    </div>
  );
}
