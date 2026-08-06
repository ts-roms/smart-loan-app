import { Button } from "@loan/ui";
import { Home, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";

import { ErrorLayout } from "./ErrorLayout";

/**
 * 500.
 *
 * Distinct from the crash page next door, and the distinction is the
 * only reason both exist: this one says the failure is ours and that
 * retrying is reasonable. The crash page can't promise that, because a
 * component that threw once will usually throw again on the same data.
 *
 * Deliberately says nothing about what failed. On a lending system the
 * plausible details — an account number, a borrower's name, a stack
 * frame naming an internal service — are exactly what shouldn't be
 * rendered to whoever happens to be at the screen.
 */
export function ServerErrorPage() {
  return (
    <ErrorLayout
      code="500"
      tone="danger"
      title="Something went wrong on our end"
      message="This one is ours, not yours. Nothing you submitted has been lost — anything already saved is safe."
      actions={
        <>
          <Button onClick={() => window.location.reload()}>
            <RefreshCw className="h-4 w-4" />
            Try again
          </Button>
          <Button variant="outline" asChild>
            <Link to="/">
              <Home className="h-4 w-4" />
              Dashboard
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
