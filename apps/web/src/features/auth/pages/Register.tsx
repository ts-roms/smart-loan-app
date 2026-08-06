import { ApiError, useRegister } from "@loan/api-client";
import { Button, Input, PasswordInput, useToast } from "@loan/ui";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { AuthShell } from "../components/AuthShell";

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
    <AuthShell
      title="Create your account"
      subtitle={
        tenantSlug ? (
          <>
            Joining <code className="text-primary">{tenantSlug}</code>. Takes a
            minute — we&apos;ll ask for your details next.
          </>
        ) : (
          "Takes a minute. We'll ask for your details next."
        )
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
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
          <PasswordInput
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {tooShort && (
            <p className="text-[11px] text-warning">At least 8 characters.</p>
          )}
        </div>
        <div className="space-y-1">
          <label className="text-sm">Confirm password</label>
          <PasswordInput
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
            className="font-medium text-primary underline underline-offset-4"
          >
            Sign in
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}
