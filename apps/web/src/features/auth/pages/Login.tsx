import { ApiError, useLogin } from "@loan/api-client";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  PasswordInput,
} from "@loan/ui";
import { AlertCircle, Check, Lock, Wallet } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
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
    /*
     * Two panes: brand on the left, form on the right.
     *
     * `lg:` rather than `md:` — the brand pane needs enough width for
     * the copy to breathe, and at 768px the two columns squeeze the
     * form narrower than the single-column layout it replaces. Below
     * that the pane is dropped entirely and a compact lockup sits above
     * the form, so a phone gets one focused column rather than a
     * shrunken version of the desktop design.
     */
    <div className="min-h-screen lg:grid lg:grid-cols-2">
      <BrandPane />

      <div className="flex min-h-screen items-center justify-center p-4 lg:min-h-0">
        <Card className="w-full max-w-sm border-0 bg-transparent shadow-none lg:border lg:bg-surface-2 lg:shadow-sm">
          <CardHeader className="text-center">
            {/* The lockup the brand pane would otherwise carry. */}
            <div className="mb-2 flex items-center justify-center gap-2 lg:hidden">
              <Wallet className="h-6 w-6 text-primary" />
              <span className="text-xl font-semibold">SmartLoan</span>
            </div>
            <CardTitle>Sign in</CardTitle>
            {tenantSlug && (
              <p className="text-xs text-fg-muted mt-1">
                Tenant: <code className="text-info">{tenantSlug}</code>
              </p>
            )}
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="space-y-3">
              {error && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
              <div className="space-y-1">
                <label className="text-sm">Email</label>
                <Input
                  type="email"
                  autoComplete="username"
                  placeholder="E-mail"
                  value={email}
                  // Clearing on edit: the message describes the attempt
                  // you just made, and it stops describing it the
                  // moment you start changing the inputs.
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setError(null);
                  }}
                  required
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm">Password</label>
                <PasswordInput
                  autoComplete="current-password"
                  placeholder="Password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError(null);
                  }}
                  required
                />
              </div>
              {requires2fa && !useRecovery && (
                <div className="space-y-1">
                  <label className="text-sm flex items-center gap-1">
                    <Lock className="h-3 w-3" /> 6-digit code
                  </label>
                  <Input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    placeholder="000000"
                    value={totpCode}
                    onChange={(e) =>
                      setTotpCode(e.target.value.replace(/\D/g, ""))
                    }
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => setUseRecovery(true)}
                    className="text-[10px] text-fg-muted underline mt-1"
                  >
                    Lost your device? Use a recovery code instead
                  </button>
                </div>
              )}
              {requires2fa && useRecovery && (
                <div className="space-y-1">
                  <label className="text-sm flex items-center gap-1">
                    <Lock className="h-3 w-3" /> Recovery code
                  </label>
                  <Input
                    placeholder="XXXX-XXXX"
                    value={recoveryCode}
                    onChange={(e) =>
                      setRecoveryCode(e.target.value.toUpperCase())
                    }
                    autoFocus
                  />
                  <button
                    type="button"
                    onClick={() => setUseRecovery(false)}
                    className="text-[10px] text-fg-muted underline mt-1"
                  >
                    Back to TOTP code
                  </button>
                </div>
              )}
              <Button
                type="submit"
                className="w-full"
                disabled={login.isPending}
              >
                {login.isPending
                  ? "Signing in…"
                  : requires2fa
                    ? "Verify and sign in"
                    : "Sign in"}
              </Button>
              <p className="text-xs text-fg-subtle text-center pt-2">
                New member?{" "}
                <Link
                  to={
                    tenantSlug ? `/register?tenant=${tenantSlug}` : "/register"
                  }
                  className="text-info underline"
                >
                  Create an account
                </Link>
              </p>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/**
 * The left pane. Purely decorative — it carries no form control, so it
 * is `aria-hidden` and hidden outright below lg rather than reflowed:
 * a screen-reader user gets the lockup above the form instead of the
 * same words twice.
 *
 * Uses the static brand, not useBranding(). /system/branding sits
 * behind app.authenticate and 401s here, which is correct — per-tenant
 * branding can't be shown before we know which tenant is asking.
 */
function BrandPane() {
  return (
    <div
      aria-hidden="true"
      className="relative hidden overflow-hidden bg-surface-2 p-12 lg:flex lg:flex-col lg:justify-between"
    >
      {/*
        Two soft primary washes. Opacity comes from --glow-a/--glow-b,
        which differ per theme, so the effect stays subtle on the light
        plate instead of turning into a visible blue smear.
      */}
      <div
        className="pointer-events-none absolute -left-24 -top-24 h-96 w-96 rounded-full bg-primary blur-3xl"
        style={{ opacity: "var(--glow-a)" }}
      />
      <div
        className="pointer-events-none absolute -bottom-32 -right-16 h-[28rem] w-[28rem] rounded-full bg-primary blur-3xl"
        style={{ opacity: "var(--glow-b)" }}
      />

      <div className="relative flex items-center gap-2.5">
        <Wallet className="h-7 w-7 text-primary" />
        <span className="text-xl font-semibold tracking-tight">SmartLoan</span>
      </div>

      <div className="relative max-w-md space-y-4">
        <h1 className="text-3xl font-semibold leading-tight tracking-tight">
          Lending operations for Philippine cooperatives.
        </h1>
        <p className="text-sm leading-relaxed text-fg-muted">
          Origination, KYC, decisioning, collections and the general ledger —
          one system, on your own hardware.
        </p>
        <ul className="space-y-2 pt-2">
          {[
            "Applications scored and decided against your own rules",
            "Every payment posted to a double-entry ledger",
            "Collections queues, promises to pay, demand letters",
          ].map((line) => (
            <li key={line} className="flex items-start gap-2 text-sm">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span className="text-fg-muted">{line}</span>
            </li>
          ))}
        </ul>
      </div>

      <p className="relative text-xs text-fg-subtle">
        © {new Date().getFullYear()} SmartLoan
      </p>
    </div>
  );
}
