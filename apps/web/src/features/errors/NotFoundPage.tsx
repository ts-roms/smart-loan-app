import { useBranding } from "@loan/api-client";
import { Button } from "@loan/ui";
import { ArrowLeft, Compass, Home } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { ErrorLayout } from "./ErrorLayout";

/**
 * 404 — the cover variant.
 *
 * This replaces a silent `<Navigate to="/" />` on the catch-all route.
 * The redirect was worse than it looks: a mistyped or dead link dumped
 * the reader on the dashboard with no indication anything had gone
 * wrong, so a stale bookmark looked like the app losing their page —
 * and nobody ever reported the broken link, because nobody could tell
 * there was one.
 *
 * The path is echoed back for exactly that reason. It's usually the
 * whole diagnosis ("…/loans/undefined"), and it costs nothing to show.
 */
export function NotFoundPage() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const branding = useBranding();

  return (
    <ErrorLayout
      variant="cover"
      code="404"
      // A compass rather than a warning triangle. Being on a page that
      // doesn't exist is a navigation problem, not a fault, and the
      // page shouldn't open by implying the reader broke something.
      icon={Compass}
      title="Sorry, page not found"
      message="The link may be out of date, or the page may have moved. Nothing is wrong with your account."
      actions={
        <>
          {/*
            Back first: a 404 is nearly always reached FROM somewhere,
            and returning there is what the reader wants far more often
            than starting again at the dashboard.
          */}
          <Button variant="outline" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-4 w-4" />
            Go back
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
        <div className="text-xs text-fg-subtle">
          <span className="uppercase tracking-wider">Requested</span>
          <div className="mt-1 break-all font-mono text-fg-muted">
            {pathname}
          </div>
        </div>
      }
      footer={`© ${new Date().getFullYear()} ${branding.data?.companyName ?? "SmartLoan"}`}
    />
  );
}
