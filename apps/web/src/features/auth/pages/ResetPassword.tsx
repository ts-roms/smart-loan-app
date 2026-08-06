import { useResetPassword, useResetTokenStatus } from "@loan/api-client";
import { Button, PasswordInput, SkeletonCard } from "@loan/ui";
import { AlertCircle, CheckCircle2, ShieldAlert } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { AuthShell } from "../components/AuthShell";

/** Matches the API, which matches registration. */
const MIN_LENGTH = 8;

/**
 * Redeem a reset link.
 *
 * The link is checked when the page opens rather than on submit, so
 * someone with a stale link is told immediately instead of after
 * typing a password twice.
 */
export function ResetPasswordPage() {
  const { token = "" } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const status = useResetTokenStatus(token);
  const reset = useResetPassword();

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < MIN_LENGTH) {
      setError(`Use at least ${MIN_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("The two passwords don't match.");
      return;
    }
    setError(null);
    try {
      await reset.mutateAsync({ token, password });
      setDone(true);
    } catch (err) {
      setError((err as Error).message ?? "Couldn't set your new password.");
    }
  };

  if (status.isLoading) {
    return (
      <AuthShell title="Reset your password">
        <SkeletonCard />
      </AuthShell>
    );
  }

  // Covers expired, already-used and forged alike. The API names the
  // reason but the distinction doesn't change what the reader does
  // next: ask for another link.
  if (status.isError) {
    return (
      <AuthShell title="This link has expired">
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-3 text-sm">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div>
              Reset links work once and last an hour. This one has been used or
              has run out.
            </div>
          </div>
          <Link
            to="/forgot-password"
            className="inline-block text-sm font-medium text-primary underline underline-offset-4"
          >
            Request a new link
          </Link>
        </div>
      </AuthShell>
    );
  }

  if (done) {
    return (
      <AuthShell title="Password updated">
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-md border border-success/30 bg-success/10 px-3 py-3 text-sm">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
            <div>
              You&apos;re set. Everywhere you were signed in has been signed
              out, so use the new password from now on.
            </div>
          </div>
          <Button
            variant="success"
            className="w-full"
            onClick={() => void navigate("/login", { replace: true })}
          >
            Sign in
          </Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Choose a new password"
      subtitle="Signing you out of any other devices at the same time."
    >
      <form onSubmit={onSubmit} className="space-y-4">
        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="space-y-1.5">
          <label htmlFor="password" className="text-sm font-medium">
            New password
          </label>
          <PasswordInput
            id="password"
            autoComplete="new-password"
            placeholder={`At least ${MIN_LENGTH} characters`}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError(null);
            }}
            required
            autoFocus
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="confirm" className="text-sm font-medium">
            Confirm password
          </label>
          <PasswordInput
            id="confirm"
            autoComplete="new-password"
            placeholder="Type it again"
            value={confirm}
            onChange={(e) => {
              setConfirm(e.target.value);
              setError(null);
            }}
            required
          />
        </div>

        <Button
          type="submit"
          variant="success"
          className="w-full"
          loading={reset.isPending}
        >
          Set new password
        </Button>
      </form>
    </AuthShell>
  );
}
