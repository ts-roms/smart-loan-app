import { ApiError, useRegister } from "@loan/api-client";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  useToast,
} from "@loan/ui";
import { Wallet } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { useAuth } from "../../../providers/auth";

/**
 * Member sign-up. Deliberately short: a name, an email, a password.
 *
 * Everything a loan file actually needs — legal name, birth date,
 * address, government ID, income — is collected on the next screen
 * (`CompleteProfilePage`), after the account exists. Splitting it this
 * way means a prospective borrower commits to a form they can finish
 * in fifteen seconds, and if they abandon the longer one their account
 * still exists to come back to.
 *
 * The server creates a CUSTOMER with no linked Customer row, so the
 * session this returns can reach the profile form and nothing else.
 */
export function RegisterPage() {
  const { signIn } = useAuth();
  const register = useRegister();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const tenantSlug = params.get("tenant") ?? undefined;
  const toast = useToast();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  // Mirrors the server's `registerSchema` (min 8). Checked here purely
  // so the user finds out before a round trip; the server is still the
  // authority.
  const tooShort = password.length > 0 && password.length < 8;
  const mismatch = confirm.length > 0 && confirm !== password;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (tooShort || mismatch) return;
    try {
      const res = await register.mutateAsync({
        name,
        email,
        password,
        ...(tenantSlug ? { tenantSlug } : {}),
      });
      signIn({
        accessToken: res.accessToken,
        refreshToken: res.refreshToken,
        user: res.user,
      });
      // No explicit navigation: the account has no customerId yet, so
      // App renders the profile gate on the next paint.
      void navigate("/", { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast.error("That email already has an account. Try signing in.");
        return;
      }
      toast.error((err as Error).message ?? "Sign-up failed");
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="flex items-center justify-center gap-2 mb-2">
            <Wallet className="h-6 w-6 text-info" />
            <span className="text-xl font-semibold">SmartLoan</span>
          </div>
          <CardTitle>Create your account</CardTitle>
          <p className="text-xs text-fg-muted mt-1">
            Takes a minute. We&apos;ll ask for your details next.
          </p>
          {tenantSlug && (
            <p className="text-xs text-fg-muted mt-1">
              Cooperative: <code className="text-info">{tenantSlug}</code>
            </p>
          )}
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-3">
            <div className="space-y-1">
              <label className="text-sm">Full name</label>
              <Input
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm">Email</label>
              <Input
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm">Password</label>
              <Input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              {tooShort && (
                <p className="text-[11px] text-warning">
                  At least 8 characters.
                </p>
              )}
            </div>
            <div className="space-y-1">
              <label className="text-sm">Confirm password</label>
              <Input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
              {mismatch && (
                <p className="text-[11px] text-warning">
                  Passwords don&apos;t match.
                </p>
              )}
            </div>
            <Button
              type="submit"
              className="w-full"
              disabled={register.isPending || tooShort || mismatch}
            >
              {register.isPending ? "Creating account…" : "Create account"}
            </Button>
            <p className="text-xs text-fg-subtle text-center pt-2">
              Already a member?{" "}
              <Link
                to={tenantSlug ? `/login?tenant=${tenantSlug}` : "/login"}
                className="text-info underline"
              >
                Sign in
              </Link>
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
