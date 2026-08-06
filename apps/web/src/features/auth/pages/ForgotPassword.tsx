import { useForgotPassword } from "@loan/api-client";
import { Button, Input } from "@loan/ui";
import { MailCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { AuthShell } from "../components/AuthShell";

/**
 * Request a reset link.
 *
 * The confirmation is deliberately the same whether the address has an
 * account or not — the API answers identically by design, and a UI
 * that said "no account with that email" would hand back the
 * enumeration oracle the endpoint exists to close. For a lender that
 * means confirming who banks here to anyone with a guess.
 *
 * So the wording is careful: "if that address has an account", not
 * "we've sent you an email". It's honest about the uncertainty rather
 * than implying something we won't confirm.
 */
export function ForgotPasswordPage() {
  const [params] = useSearchParams();
  const tenantSlug = params.get("tenant") ?? undefined;
  const forgot = useForgotPassword();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await forgot.mutateAsync({
        email,
        ...(tenantSlug ? { tenantSlug } : {}),
      });
    } catch {
      // Swallowed on purpose. A failure here is almost always the rate
      // limit, and reporting it differently from success would leak
      // that the address was worth limiting.
    }
    setSent(true);
  };

  const loginHref = tenantSlug ? `/login?tenant=${tenantSlug}` : "/login";

  if (sent) {
    return (
      <AuthShell title="Check your email">
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-md border border-success/30 bg-success/10 px-3 py-3 text-sm">
            <MailCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" />
            <div>
              If <strong>{email}</strong> has an account, a reset link is on its
              way. It works once and expires in an hour.
            </div>
          </div>
          <p className="text-sm text-fg-muted">
            Nothing arrived? Check the spam folder, then{" "}
            <button
              type="button"
              onClick={() => setSent(false)}
              className="font-medium text-primary underline underline-offset-4"
            >
              try another address
            </button>
            .
          </p>
          <Link
            to={loginHref}
            className="inline-block text-sm font-medium text-primary underline underline-offset-4"
          >
            Back to sign in
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Forgot your password?"
      subtitle="Enter your email and we'll send you a link to set a new one."
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <label htmlFor="email" className="text-sm font-medium">
            Email
          </label>
          <Input
            id="email"
            type="email"
            autoComplete="username"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </div>

        <Button
          type="submit"
          variant="success"
          className="w-full"
          loading={forgot.isPending}
        >
          Send reset link
        </Button>

        <p className="pt-1 text-center text-sm text-fg-muted">
          Remembered it?{" "}
          <Link
            to={loginHref}
            className="font-medium text-primary underline underline-offset-4"
          >
            Sign in
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}
