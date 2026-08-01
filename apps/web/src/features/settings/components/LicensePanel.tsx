import {
  useActivateLicense,
  useDeactivateLicense,
  useLicenseStatus,
} from "@loan/api-client";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  SkeletonLine,
  useConfirm,
  useToast,
} from "@loan/ui";
import { formatDate } from "@loan/shared-utils";
import {
  AlertTriangle,
  CheckCircle2,
  Key,
  KeySquare,
  ShieldOff,
  XCircle,
} from "lucide-react";
import { useState } from "react";

import { useAuth } from "../../../providers/auth";

/**
 * License activation + status panel. Admin-only by design — the
 * activate / deactivate buttons are 403-gated server-side (admin.roles),
 * but we also hide the controls in the UI for non-admins so they don't
 * see disabled buttons they can't act on.
 *
 * Status is read-only for everyone — non-admins still see "your org is
 * on ENTERPRISE, expires in 87 days" so they understand what they have
 * access to (and can chase their admin when something's missing).
 */
export function LicensePanel() {
  const { data, isLoading, error } = useLicenseStatus();
  const activate = useActivateLicense();
  const deactivate = useDeactivateLicense();
  const toast = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  const canManage = user?.role === "ADMIN";

  const [tokenInput, setTokenInput] = useState("");

  const onActivate = async () => {
    if (!tokenInput.trim()) {
      toast.error("Paste a license token first");
      return;
    }
    try {
      await activate.mutateAsync({ token: tokenInput.trim() });
      toast.success("License activated");
      setTokenInput("");
    } catch (err) {
      // The api-client throws on non-2xx with the server message
      // attached. Show it verbatim — the server messages are tuned
      // to be operator-friendly (Expired / BadSignature / etc).
      toast.error((err as Error).message ?? "Activation failed");
    }
  };

  const onDeactivate = async () => {
    const ok = await confirm({
      title: "Deactivate the current license?",
      message:
        "Every premium feature on this instance will stop working until a fresh license is activated. Core features (customers, loans, KYC) keep running.",
      confirmLabel: "Deactivate",
      tone: "destructive",
    });
    if (!ok) return;
    try {
      await deactivate.mutateAsync();
      toast.success("License deactivated");
    } catch (err) {
      toast.error((err as Error).message ?? "Deactivation failed");
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 flex-wrap">
        <CardTitle className="flex items-center gap-2">
          <KeySquare className="h-4 w-4 text-sky-300" />
          License
        </CardTitle>
        {data?.status && <StatusBadge status={data.status} />}
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <SkeletonLine className="h-16" />
        ) : error ? (
          <p className="text-sm text-rose-300">
            Could not load license status: {error.message}
          </p>
        ) : data?.status === "ACTIVE" ? (
          <ActiveLicenseSummary data={data} />
        ) : (
          <InactiveLicenseMessage status={data} />
        )}

        {canManage && (
          <div className="space-y-2 border-t border-white/10 pt-4">
            <div className="text-[10px] uppercase tracking-wider text-fg-subtle">
              {data?.status === "ACTIVE" ? "Replace or extend" : "Activate"}
            </div>
            <textarea
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              rows={4}
              placeholder="Paste your SMARTLOAN-LIC-v1... token here"
              className="w-full font-mono text-xs rounded-md border border-white/15 bg-white/[0.04] p-2"
              spellCheck={false}
            />
            <div className="flex gap-2">
              <Button onClick={onActivate} disabled={activate.isPending}>
                <Key className="h-4 w-4" />
                {activate.isPending ? "Activating…" : "Activate"}
              </Button>
              {data?.status === "ACTIVE" && (
                <Button
                  variant="outline"
                  onClick={onDeactivate}
                  disabled={deactivate.isPending}
                >
                  <ShieldOff className="h-4 w-4" />
                  {deactivate.isPending ? "Deactivating…" : "Deactivate"}
                </Button>
              )}
            </div>
            <p className="text-[10px] text-fg-subtle">
              Tokens come from your platform contact. Pasting a renewal replaces
              the current one — no need to deactivate first.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StatusBadge({
  status,
}: {
  status: NonNullable<ReturnType<typeof useLicenseStatus>["data"]>["status"];
}) {
  if (status === "ACTIVE")
    return (
      <Badge variant="success" className="gap-1">
        <CheckCircle2 className="h-3 w-3" />
        ACTIVE
      </Badge>
    );
  if (status === "EXPIRED")
    return (
      <Badge variant="danger" className="gap-1">
        <XCircle className="h-3 w-3" />
        EXPIRED
      </Badge>
    );
  if (status === "TAMPERED")
    return (
      <Badge variant="danger" className="gap-1">
        <AlertTriangle className="h-3 w-3" />
        TAMPERED
      </Badge>
    );
  if (status === "NO_KEY")
    return (
      <Badge variant="muted" className="gap-1">
        <AlertTriangle className="h-3 w-3" />
        NOT CONFIGURED
      </Badge>
    );
  return (
    <Badge variant="muted" className="gap-1">
      <AlertTriangle className="h-3 w-3" />
      NONE
    </Badge>
  );
}

function ActiveLicenseSummary({
  data,
}: {
  data: NonNullable<ReturnType<typeof useLicenseStatus>["data"]>;
}) {
  const daysLeft = data.daysUntilExpiry ?? 0;
  const expiringSoon = daysLeft <= 30 && daysLeft > 0;

  return (
    <div className="space-y-2 text-sm">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Tenant" value={data.tenant ?? "—"} />
        <Field label="Tier" value={data.tier ?? "—"} />
        <Field
          label="Expires"
          value={
            data.expiresAt
              ? `${formatDate(data.expiresAt)} (${daysLeft} day${daysLeft === 1 ? "" : "s"})`
              : "—"
          }
          highlight={expiringSoon ? "amber" : undefined}
        />
        <Field
          label="Seats"
          value={data.seats === 0 ? "Unlimited" : String(data.seats ?? "—")}
        />
      </div>
      {data.notes && (
        <div className="text-xs text-fg-muted border-l-2 border-white/10 pl-2">
          {data.notes}
        </div>
      )}
      {data.features && data.features.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-fg-subtle">
            Unlocked features ({data.features.length})
          </summary>
          <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 pl-2 pt-1">
            {data.features.map((f) => (
              <code key={f} className="text-[10px] text-fg-muted">
                {f}
              </code>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function InactiveLicenseMessage({
  status,
}: {
  status: ReturnType<typeof useLicenseStatus>["data"];
}) {
  if (!status) return null;
  return (
    <div className="rounded-md border border-amber-300/20 bg-amber-300/[0.04] p-3 text-sm">
      <div className="font-medium text-amber-200 mb-1">
        {status.status === "EXPIRED" && "License expired"}
        {status.status === "TAMPERED" && "License signature invalid"}
        {status.status === "NO_KEY" && "License key not configured"}
        {status.status === "NONE" && "No license activated"}
      </div>
      <p className="text-xs text-fg-muted">
        {status.message ??
          "Premium features (DORSI, AI assistant, ECL, cooperative, lease) are locked. Core lending features (customers, loans, KYC, basic accounting) keep working."}
      </p>
    </div>
  );
}

function Field({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: "amber";
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-fg-subtle">
        {label}
      </div>
      <div
        className={
          highlight === "amber"
            ? "text-sm text-amber-200 font-medium"
            : "text-sm"
        }
      >
        {value}
      </div>
    </div>
  );
}
