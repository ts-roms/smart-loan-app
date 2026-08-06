import { Button } from "@loan/ui";
import { Home, RefreshCw, ServerCrash } from "lucide-react";
import { Link } from "react-router-dom";

import { ErrorLayout } from "./ErrorLayout";

/**
 * 500 — the plain variant, no banner.
 *
 * The 404 gets a brand band because being on a page that doesn't exist
 * is an ordinary place to end up. This isn't; dressing it up would be
 * at odds with what it has to say.
 *
 * Distinct from the crash page next door, and the distinction is the
 * only reason both exist: this one says the failure is ours and that
 * retrying is reasonable. The crash page can't promise that, because a
 * component that threw once will usually throw again on the same data.
 *
 * Says nothing about WHAT failed, deliberately. On a lending system the
 * plausible details — an account number, a borrower's name, a frame
 * naming an internal service — are exactly what shouldn't be rendered
 * to whoever happens to be at the screen.
 */
export function ServerErrorPage() {
  return (
    <ErrorLayout
      code="500"
      tone="danger"
      icon={ServerCrash}
      title="Internal server error"
      message="This one is ours, not yours. Nothing you submitted has been lost, and anything already saved is safe."
      actions={
        <>
          <Button variant="outline" onClick={() => window.location.reload()}>
            <RefreshCw className="h-4 w-4" />
            Try again
          </Button>
          <Button variant="success" asChild>
            <Link to="/">
              <Home className="h-4 w-4" />
              Back to home
            </Link>
          </Button>
        </>
      }
      details={
        <p className="text-xs text-fg-subtle">
          If it keeps happening, tell your administrator roughly when it started
          and what you were doing — that pair is usually enough to find it in
          the logs.
        </p>
      }
    />
  );
}
