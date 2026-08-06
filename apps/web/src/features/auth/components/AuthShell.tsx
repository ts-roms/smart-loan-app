import { Check, Wallet } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The shell both auth pages sit in.
 *
 * A single card floating on a full-bleed teal→navy gradient, split
 * into a brand panel and the form. Shared rather than duplicated
 * because sign-in and registration are the same moment in two states —
 * they should not drift apart visually.
 *
 * The gradient runs edge to edge behind everything, which is the point:
 * these are the only two screens with no nav, no data and no chrome, so
 * they can carry the brand in a way the console never should.
 */
export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="auth-backdrop relative flex min-h-screen flex-col items-center justify-center px-4 py-10">
      <div className="relative w-full max-w-4xl overflow-hidden rounded-xl bg-surface-2 shadow-2xl lg:grid lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1fr)]">
        <BrandPanel />

        <div className="p-6 sm:p-9">
          {/* The lockup the brand panel carries on desktop. Repeated
              here rather than reflowed, so a phone gets one focused
              column instead of a squeezed two. */}
          <div className="mb-6 flex items-center gap-2.5 lg:hidden">
            <Wallet className="h-6 w-6 text-primary" />
            <span className="text-lg font-semibold tracking-tight">
              SmartLoan
            </span>
          </div>

          <h1 className="text-xl font-semibold tracking-tight text-primary">
            {title}
          </h1>
          {subtitle && <p className="mt-1 text-sm text-fg-muted">{subtitle}</p>}

          <div className="mt-6">{children}</div>
        </div>
      </div>

      <p className="relative mt-6 text-xs text-white/70">
        © {new Date().getFullYear()} SmartLoan
      </p>
    </div>
  );
}

/**
 * Brand panel. Decorative — it carries no form control, so it's
 * `aria-hidden` and dropped below lg rather than reflowed: a
 * screen-reader user gets the lockup above the form instead of the
 * same words twice.
 *
 * Uses the static brand, not useBranding(). `/system/branding` sits
 * behind app.authenticate and 401s here, which is correct — per-tenant
 * branding can't be shown before we know which tenant is asking.
 */
function BrandPanel() {
  return (
    <div
      aria-hidden="true"
      className="auth-brand-panel relative hidden flex-col justify-between overflow-hidden p-9 text-white lg:flex"
    >
      <div className="relative flex items-center gap-2.5">
        <Wallet className="h-7 w-7" />
        <span className="text-xl font-semibold tracking-tight">SmartLoan</span>
      </div>

      <div className="relative space-y-4">
        <h2 className="text-2xl font-semibold leading-tight tracking-tight">
          Lending operations for Philippine cooperatives.
        </h2>
        <p className="text-sm leading-relaxed text-white/75">
          Origination, KYC, decisioning, collections and the general ledger —
          one system, on your own hardware.
        </p>
        <ul className="space-y-2 pt-1">
          {[
            "Applications scored and decided against your own rules",
            "Every payment posted to a double-entry ledger",
            "Collections queues, promises to pay, demand letters",
          ].map((line) => (
            <li key={line} className="flex items-start gap-2 text-sm">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-white/90" />
              <span className="text-white/75">{line}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="relative text-xs text-white/60">
        On your own hardware. Your data stays yours.
      </div>
    </div>
  );
}
