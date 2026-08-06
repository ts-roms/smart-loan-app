import { Button } from "@loan/ui";
import { ArrowLeft, Home } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { ErrorLayout } from "./ErrorLayout";

/**
 * 404.
 *
 * This replaces a silent `<Navigate to="/" />` on the catch-all route.
 * The redirect was worse than it looks: a mistyped or dead link dumped
 * the reader on the dashboard with no indication anything had gone
 * wrong, so a stale bookmark looked like the app losing their page —
 * and nobody ever reported the broken link, because nobody could tell
 * there was one.
 *
 * The path is echoed back for exactly that reason. It's usually the
 * whole diagnosis ("…/loans/undefined"), and it costs the reader
 * nothing to see it.
 */
export function NotFoundPage() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return (
    <ErrorLayout
      code="404"
      title="We couldn't find that page"
      message="The link may be out of date, or the page may have moved. Nothing is broken on your account."
      actions={
        <>
          {/*
            Back first: a 404 is usually reached from somewhere, and
            returning there is what the reader wants far more often than
            starting over at the dashboard.
          */}
          <Button variant="outline" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-4 w-4" />
            Go back
          </Button>
          <Button asChild>
            <Link to="/">
              <Home className="h-4 w-4" />
              Dashboard
            </Link>
          </Button>
        </>
      }
      details={
        <div className="text-xs text-fg-subtle">
          <span className="uppercase tracking-wider">Requested</span>
          <div className="mt-1 break-all font-mono text-fg-muted">
            {pathname}
          </div>
        </div>
      }
    />
  );
}
