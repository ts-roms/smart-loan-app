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
      {/*
        Every field carries an id and every label an htmlFor. They had
        neither: the labels were bare <label> elements sitting next to
        unidentified inputs, so a screen reader announced four unnamed
        edit boxes and clicking a label focused nothing. The sign-in
        page next door has always been wired correctly, which is
        precisely why this went unnoticed.

        The validation hints are tied on with aria-describedby for the
        same reason — a message that only exists visually is no message
        to someone who can't see it — and paired with aria-invalid so
        the field itself reports its state rather than relying on a
        sentence underneath it.
      */}
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-1">
          <label htmlFor="reg-name" className="text-sm font-medium">
            Full name
          </label>
          <Input
            id="reg-name"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="reg-email" className="text-sm font-medium">
            Email
          </label>
          <Input
            id="reg-email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="reg-password" className="text-sm font-medium">
            Password
          </label>
          <PasswordInput
            id="reg-password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={tooShort || undefined}
            aria-describedby={tooShort ? "reg-password-hint" : undefined}
            required
          />
          {tooShort && (
            <p id="reg-password-hint" className="text-[11px] text-warning">
              At least 8 characters.
            </p>
          )}
        </div>
        <div className="space-y-1">
          <label htmlFor="reg-confirm" className="text-sm font-medium">
            Confirm password
          </label>
          <PasswordInput
            id="reg-confirm"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            // Distinct from the field above, so the two reveal toggles
            // don't both announce "Show password".
            revealLabel="confirmation"
            aria-invalid={mismatch || undefined}
            aria-describedby={mismatch ? "reg-confirm-hint" : undefined}
            required
          />
          {mismatch && (
            <p id="reg-confirm-hint" className="text-[11px] text-warning">
              Passwords don&apos;t match.
            </p>
          )}
        </div>
        <Button
          type="submit"
          // Teal, matching Velzon's auth pages — they use btn-success
          // here rather than the navy btn-primary.
          variant="success"
          className="w-full"
          loading={register.isPending}
          disabled={tooShort || mismatch}
        >
          Create account
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
