import { ApiError, useLogin } from "@loan/api-client";
import { Button, Input, PasswordInput } from "@loan/ui";
import { AlertCircle, Lock } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { AuthShell } from "../components/AuthShell";
import { useAuth } from "../../../providers/auth";

/**
 * Sign-in. After a successful POST we stash the token + user in the
 * auth provider; the App's router will swing over to the dashboard
 * automatically on the next render.
 *
 * Multi-tenant deployments: the tenant slug is read from the URL
 * query (`?tenant=<slug>`) and forwarded with the login request. In
 * single-tenant deployments the query param is absent and the server
 * falls back to DEFAULT_TENANT_SLUG. Full path-prefix routing (`/t/<slug>`)
 * lands in P2.4+; for now the deep-link / vendor email is the entry
 * point.
 */
export function LoginPage() {
  const { signIn } = useAuth();
  const login = useLogin();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const tenantSlug = params.get("tenant") ?? undefined;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [requires2fa, setRequires2fa] = useState(false);
  const [useRecovery, setUseRecovery] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  /**
   * Shown in the form, not just as a toast.
   *
   * A toast slides away on a timer and sits in a corner, away from
   * the fields it's about. Sign-in failure is the one message that has
   * to still be there while you re-read what you typed.
   */
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await login.mutateAsync({
        email,
        password,
        ...(tenantSlug ? { tenantSlug } : {}),
        ...(useRecovery
          ? { recoveryCode }
          : { totpCode: totpCode || undefined }),
      });
      signIn({
        accessToken: res.accessToken,
        refreshToken: res.refreshToken,
        user: res.user,
      });
      void navigate("/", { replace: true });
    } catch (err) {
      // Server signals "needs 2FA" via a 401 with `requires2fa: true` in
      // the body. Switch the form into 2FA mode instead of toasting an
      // error — keeps the password the user just typed and prompts for
      // the code.
      if (
        err instanceof ApiError &&
        err.body &&
        typeof err.body === "object" &&
        "requires2fa" in err.body
      ) {
        setRequires2fa(true);
        // Only an error once they've actually entered a code — the
        // first 401 here just means "now show me the second factor".
        if (totpCode || recoveryCode) {
          setError((err as Error).message ?? "That code isn't right.");
        }
        return;
      }
      setError(
        (err as Error).message ??
          "Couldn't sign in. Check your connection and try again.",
      );
    }
  };

  return (
    <AuthShell
      title="Welcome back"
      subtitle={
        tenantSlug ? (
          <>
            Sign in to <code className="text-primary">{tenantSlug}</code>.
          </>
        ) : (
          "Sign in to continue."
        )
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

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
            // Clearing on edit: the message describes the attempt you
            // just made, and stops describing it the moment you start
            // changing the inputs.
            onChange={(e) => {
              setEmail(e.target.value);
              setError(null);
            }}
            required
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="password" className="text-sm font-medium">
            Password
          </label>
          <PasswordInput
            id="password"
            autoComplete="current-password"
            placeholder="Enter password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError(null);
            }}
            required
          />
        </div>

        {requires2fa && !useRecovery && (
          <div className="space-y-1.5">
            <label className="flex items-center gap-1 text-sm font-medium">
              <Lock className="h-3 w-3" /> 6-digit code
            </label>
            <Input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="000000"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ""))}
              autoFocus
            />
            <button
              type="button"
              onClick={() => setUseRecovery(true)}
              className="mt-1 text-[11px] text-fg-muted underline"
            >
              Lost your device? Use a recovery code instead
            </button>
          </div>
        )}

        {requires2fa && useRecovery && (
          <div className="space-y-1.5">
            <label className="flex items-center gap-1 text-sm font-medium">
              <Lock className="h-3 w-3" /> Recovery code
            </label>
            <Input
              placeholder="XXXX-XXXX"
              value={recoveryCode}
              onChange={(e) => setRecoveryCode(e.target.value.toUpperCase())}
              autoFocus
            />
            <button
              type="button"
              onClick={() => setUseRecovery(false)}
              className="mt-1 text-[11px] text-fg-muted underline"
            >
              Back to TOTP code
            </button>
          </div>
        )}

        <Button type="submit" className="w-full" disabled={login.isPending}>
          {login.isPending
            ? "Signing in…"
            : requires2fa
              ? "Verify and sign in"
              : "Sign in"}
        </Button>

        <p className="pt-1 text-center text-sm text-fg-muted">
          New member?{" "}
          <Link
            to={tenantSlug ? `/register?tenant=${tenantSlug}` : "/register"}
            className="font-medium text-primary underline underline-offset-4"
          >
            Create an account
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}
