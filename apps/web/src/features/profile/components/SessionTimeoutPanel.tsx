import {
  clearUserIdleOverride,
  readUserIdleOverride,
  useEffectiveIdlePolicy,
  useUpdateIdlePolicy,
  writeUserIdleOverride,
} from "@loan/api-client";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  useToast,
} from "@loan/ui";
import { Clock, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { useAuth } from "../../../providers/auth";

/**
 * Settings panel for the idle-then-logout policy.
 *
 * Two sections, both gated by what the current user is allowed to do:
 *
 *   1. "Session timeout" — visible to everyone. User can shorten their
 *      personal timeout below the org-wide ceiling but never extend.
 *      Stored in localStorage, clamped at read time.
 *
 *   2. "Organization session policy" — ADMIN only. Edits the SystemConfig
 *      singleton (idleTimeoutSeconds + idleWarningSeconds), audit-logged
 *      server-side as SYSTEM_CONFIG_UPDATE.
 *
 * Inputs accept seconds. We could humanise (1m 30s) but the form is
 * already small; a raw seconds input plus a "(60 seconds)" caption next
 * to the saved value is unambiguous.
 */
export function SessionTimeoutPanel() {
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";
  const effective = useEffectiveIdlePolicy();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-primary" />
          Session timeout
        </CardTitle>
        <p className="text-xs text-fg-muted">
          The app signs you out automatically after a period of inactivity for
          your security. You'll see a warning with a countdown before the actual
          sign-out.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        <UserOverrideForm effective={effective} />
        {isAdmin && effective.org && <AdminPolicyForm effective={effective} />}
      </CardContent>
    </Card>
  );
}

// ─── User override (per-browser) ─────────────────────────────────────

function UserOverrideForm({
  effective,
}: {
  effective: ReturnType<typeof useEffectiveIdlePolicy>;
}) {
  const toast = useToast();
  const orgMax = effective.org?.idleTimeoutSeconds ?? 60;
  const orgWarnMax = effective.org?.idleWarningSeconds ?? 60;

  // Local form state — initialised from localStorage. Empty string means
  // "no override" (use org default).
  const [idleStr, setIdleStr] = useState("");
  const [warnStr, setWarnStr] = useState("");

  // Hydrate once when policy resolves.
  useEffect(() => {
    if (effective.isLoading) return;
    const user = readUserIdleOverride();
    setIdleStr(
      user.idleTimeoutSeconds != null ? String(user.idleTimeoutSeconds) : "",
    );
    setWarnStr(
      user.idleWarningSeconds != null ? String(user.idleWarningSeconds) : "",
    );
  }, [effective.isLoading]);

  const save = () => {
    const idleNum = idleStr === "" ? undefined : Number.parseInt(idleStr, 10);
    const warnNum = warnStr === "" ? undefined : Number.parseInt(warnStr, 10);

    // Validate against org ceiling. User can be stricter (smaller) but
    // not laxer (larger) — silently clamping would let them think they'd
    // saved something they hadn't, so we surface the error.
    if (typeof idleNum === "number") {
      if (!Number.isFinite(idleNum) || idleNum < 15) {
        toast.error("Idle timeout must be at least 15 seconds.");
        return;
      }
      if (idleNum > orgMax) {
        toast.error(`Idle timeout can't exceed the org ceiling of ${orgMax}s.`);
        return;
      }
    }
    if (typeof warnNum === "number") {
      if (!Number.isFinite(warnNum) || warnNum < 10) {
        toast.error("Warning countdown must be at least 10 seconds.");
        return;
      }
      if (warnNum > orgWarnMax) {
        toast.error(
          `Warning countdown can't exceed the org ceiling of ${orgWarnMax}s.`,
        );
        return;
      }
    }

    writeUserIdleOverride({
      idleTimeoutSeconds: idleNum,
      idleWarningSeconds: warnNum,
    });
    toast.success("Session timeout preference saved.");
  };

  const reset = () => {
    clearUserIdleOverride();
    setIdleStr("");
    setWarnStr("");
    toast.success("Reverted to organization default.");
  };

  return (
    <div className="space-y-3">
      <div className="text-xs uppercase tracking-wider text-fg-subtle">
        My preference
      </div>
      <p className="text-xs text-fg-muted">
        Override the organization default for this browser. Cannot exceed the
        policy ceiling — only shorter is allowed.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <Label>Idle before warning (seconds)</Label>
          <Input
            type="number"
            inputMode="numeric"
            min={15}
            max={orgMax}
            placeholder={`org default · ${orgMax}s`}
            value={idleStr}
            onChange={(e) => setIdleStr(e.target.value)}
          />
          <div className="text-[11px] text-fg-subtle mt-1">
            Max {orgMax}s · leave blank to use org default
          </div>
        </div>
        <div>
          <Label>Warning countdown (seconds)</Label>
          <Input
            type="number"
            inputMode="numeric"
            min={10}
            max={orgWarnMax}
            placeholder={`org default · ${orgWarnMax}s`}
            value={warnStr}
            onChange={(e) => setWarnStr(e.target.value)}
          />
          <div className="text-[11px] text-fg-subtle mt-1">
            Max {orgWarnMax}s · leave blank to use org default
          </div>
        </div>
      </div>

      {/* Current effective values — gives the user clear feedback about
          what's actually running, regardless of what they typed. */}
      <div className="rounded-md border border-default bg-surface-3 px-3 py-2 text-xs text-fg-muted">
        <span className="font-medium text-fg">Active now:</span> idle{" "}
        {effective.idleTimeoutSeconds}s
        {effective.source.idleTimeoutSeconds === "user" && (
          <span className="text-fg-subtle"> (your override)</span>
        )}
        {" · "}
        warning {effective.idleWarningSeconds}s
        {effective.source.idleWarningSeconds === "user" && (
          <span className="text-fg-subtle"> (your override)</span>
        )}
      </div>

      <div className="flex gap-2">
        <Button onClick={save}>Save preference</Button>
        <Button variant="outline" onClick={reset}>
          Reset to org default
        </Button>
      </div>
    </div>
  );
}

// ─── Admin org policy ────────────────────────────────────────────────

function AdminPolicyForm({
  effective,
}: {
  effective: ReturnType<typeof useEffectiveIdlePolicy>;
}) {
  const toast = useToast();
  const update = useUpdateIdlePolicy();
  const org = effective.org!;
  const bounds = org.bounds;

  const [idleStr, setIdleStr] = useState(String(org.idleTimeoutSeconds));
  const [warnStr, setWarnStr] = useState(String(org.idleWarningSeconds));

  // Keep inputs in sync with whatever the server reported, in case it
  // changed in another tab.
  useEffect(() => {
    setIdleStr(String(org.idleTimeoutSeconds));
    setWarnStr(String(org.idleWarningSeconds));
  }, [org.idleTimeoutSeconds, org.idleWarningSeconds]);

  const save = async () => {
    const idleNum = Number.parseInt(idleStr, 10);
    const warnNum = Number.parseInt(warnStr, 10);
    if (
      !Number.isFinite(idleNum) ||
      idleNum < bounds.idleTimeoutSeconds.min ||
      idleNum > bounds.idleTimeoutSeconds.max
    ) {
      toast.error(
        `Idle timeout must be between ${bounds.idleTimeoutSeconds.min}s and ${bounds.idleTimeoutSeconds.max}s.`,
      );
      return;
    }
    if (
      !Number.isFinite(warnNum) ||
      warnNum < bounds.idleWarningSeconds.min ||
      warnNum > bounds.idleWarningSeconds.max
    ) {
      toast.error(
        `Warning countdown must be between ${bounds.idleWarningSeconds.min}s and ${bounds.idleWarningSeconds.max}s.`,
      );
      return;
    }
    try {
      await update.mutateAsync({
        idleTimeoutSeconds: idleNum,
        idleWarningSeconds: warnNum,
      });
      toast.success("Organization session policy updated.");
    } catch (err) {
      toast.error((err as Error).message ?? "Failed to update policy.");
    }
  };

  return (
    <div className="space-y-3 pt-4 border-t border-default">
      <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-fg-subtle">
        <ShieldCheck className="h-3.5 w-3.5 text-primary" />
        Organization policy · admin only
      </div>
      <p className="text-xs text-fg-muted">
        The ceiling for everyone. Users can shorten their own timeout but can
        never extend it beyond what's set here. Changes are audit-logged.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <Label>Idle before warning (seconds)</Label>
          <Input
            type="number"
            inputMode="numeric"
            min={bounds.idleTimeoutSeconds.min}
            max={bounds.idleTimeoutSeconds.max}
            value={idleStr}
            onChange={(e) => setIdleStr(e.target.value)}
          />
          <div className="text-[11px] text-fg-subtle mt-1">
            {bounds.idleTimeoutSeconds.min}s – {bounds.idleTimeoutSeconds.max}s
          </div>
        </div>
        <div>
          <Label>Warning countdown (seconds)</Label>
          <Input
            type="number"
            inputMode="numeric"
            min={bounds.idleWarningSeconds.min}
            max={bounds.idleWarningSeconds.max}
            value={warnStr}
            onChange={(e) => setWarnStr(e.target.value)}
          />
          <div className="text-[11px] text-fg-subtle mt-1">
            {bounds.idleWarningSeconds.min}s – {bounds.idleWarningSeconds.max}s
          </div>
        </div>
      </div>

      <Button onClick={save} disabled={update.isPending}>
        {update.isPending ? "Saving…" : "Save organization policy"}
      </Button>
    </div>
  );
}
