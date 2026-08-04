import { useLicenseStatus } from "@loan/api-client";
import { AlertTriangle, KeyRound } from "lucide-react";
import { Link } from "react-router-dom";

/**
 * Top-of-shell strip that appears only when the license needs the
 * operator's attention. Renders nothing on a healthy, mid-term
 * license — we don't want to nag day-to-day.
 *
 * Trigger conditions:
 *   - status !== ACTIVE  (NONE, EXPIRED, TAMPERED, NO_KEY)
 *   - status === ACTIVE but daysUntilExpiry <= 30
 *
 * The 5-minute background poll on useLicenseStatus keeps this current
 * without manual refresh.
 */
export function LicenseBanner() {
  const { data } = useLicenseStatus();
  if (!data) return null;

  const expiringSoon =
    data.status === "ACTIVE" &&
    typeof data.daysUntilExpiry === "number" &&
    data.daysUntilExpiry <= 30;

  if (data.status === "ACTIVE" && !expiringSoon) return null;

  const tone =
    data.status === "ACTIVE"
      ? "amber"
      : data.status === "EXPIRED" || data.status === "TAMPERED"
        ? "rose"
        : "amber";

  const Icon =
    data.status === "ACTIVE" ||
    data.status === "NO_KEY" ||
    data.status === "NONE"
      ? KeyRound
      : AlertTriangle;

  const className =
    tone === "rose"
      ? "flex items-center gap-2 border-b border-rose-500/30 bg-rose-500/10 px-4 py-2 text-xs text-danger"
      : "flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-warning";

  let message: string;
  if (data.status === "ACTIVE" && expiringSoon) {
    const d = data.daysUntilExpiry!;
    message = `License expires in ${d} day${d === 1 ? "" : "s"}. Activate the renewal in Settings → License before then to avoid service interruption.`;
  } else if (data.status === "EXPIRED") {
    message =
      "Your license has expired. Premium features are locked. Paste your renewal in Settings → License.";
  } else if (data.status === "TAMPERED") {
    message =
      "License signature failed verification. Paste a fresh token in Settings → License.";
  } else if (data.status === "NO_KEY") {
    message =
      "Licensing is not configured on this deploy. The platform key needs to be set before activation works.";
  } else {
    message =
      "No license activated. Core features work; premium ones are locked until you paste a token.";
  }

  return (
    <div className={className}>
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1">{message}</span>
      <Link
        to="/settings"
        className="underline underline-offset-4 hover:no-underline"
      >
        Open settings
      </Link>
    </div>
  );
}
