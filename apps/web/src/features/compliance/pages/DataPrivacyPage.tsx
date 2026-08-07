import {
  downloadDsarExport,
  useEraseCustomer,
  useRetentionPolicy,
  useRunRetentionPurge,
  useUpdateRetentionPolicy,
} from "@loan/api-client";
import type {
  EraseCustomerResult,
  RetentionPurgeResult,
} from "@loan/shared-types";
import { formatDateTime } from "@loan/shared-utils";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  SkeletonCard,
  useToast,
} from "@loan/ui";
import {
  AlertTriangle,
  Download,
  Eraser,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { CustomerPicker } from "../../../components/CustomerPicker";

/**
 * Data privacy — the DSAR and retention surface of the Data Privacy
 * Act (and GDPR-shaped requests generally).
 *
 * The API for all of this existed, tested and gated on
 * `admin.compliance`, with no UI calling any of it: export, erasure,
 * retention policy and manual purge were reachable only by curl. A
 * compliance obligation with no operable surface is one that quietly
 * doesn't get met — an erasure request that requires an engineer is an
 * erasure request that waits.
 *
 * The nav entry is gated on `admin.compliance` and every endpoint the
 * page calls requires that same single key, so there is no per-control
 * gating to get wrong: without the permission the link is hidden and
 * every call 403s.
 */
export function DataPrivacyPage() {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-info" />
            Data privacy
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-fg-muted">
            Data-subject requests under the Data Privacy Act: export a
            customer&apos;s complete records, or erase their personal
            information. Financial records are retained either way — the ledger
            is append-only and AMLA requires it. Every action here is audited.
          </p>
        </CardContent>
      </Card>

      <DsarCard />
      <RetentionCard />
    </div>
  );
}

// ─── DSAR: export + erasure ─────────────────────────────────────────

function DsarCard() {
  const toast = useToast();
  const [customerId, setCustomerId] = useState("");
  const [exportReason, setExportReason] = useState("");
  const [exporting, setExporting] = useState(false);
  const [erasing, setErasing] = useState(false);
  const [eraseResult, setEraseResult] = useState<EraseCustomerResult | null>(
    null,
  );

  /*
   * The erasure receipt belongs to the customer it was produced for.
   * Leaving it up while the operator picks the next customer invites
   * reading old results against a new name.
   */
  useEffect(() => setEraseResult(null), [customerId]);

  const onExport = async () => {
    setExporting(true);
    try {
      await downloadDsarExport(customerId, exportReason.trim() || undefined);
      toast.success("Export downloaded. Hand it to the data subject securely.");
    } catch (err) {
      toast.error((err as Error).message ?? "Export failed");
    } finally {
      setExporting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Data-subject request</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="max-w-xl space-y-1.5">
          <Label>Customer</Label>
          <CustomerPicker value={customerId} onChange={setCustomerId} />
        </div>

        {customerId && (
          <>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[260px] flex-1 space-y-1.5">
                <Label htmlFor="dsar-reason">
                  Reference (ticket / DSAR number, optional)
                </Label>
                <Input
                  id="dsar-reason"
                  value={exportReason}
                  onChange={(e) => setExportReason(e.target.value)}
                  placeholder="e.g. DSAR-2026-014"
                />
              </div>
              <Button onClick={onExport} loading={exporting}>
                <Download className="h-3.5 w-3.5" />
                Export everything
              </Button>
              <Button
                variant="outline"
                className="text-danger"
                onClick={() => setErasing(true)}
              >
                <Eraser className="h-3.5 w-3.5" />
                Erase personal data…
              </Button>
            </div>
            <p className="text-[11px] text-fg-subtle">
              Export downloads one JSON file with the customer&apos;s complete
              records — profile, KYC, loans, payments, screenings, scores and
              notifications. Each export writes an audit entry.
            </p>
          </>
        )}

        {eraseResult && <EraseReceipt result={eraseResult} />}
      </CardContent>

      {erasing && (
        <EraseDialog
          customerId={customerId}
          onClose={() => setErasing(false)}
          onErased={(r) => {
            setEraseResult(r);
            setErasing(false);
          }}
        />
      )}
    </Card>
  );
}

/**
 * What the erasure did, verbatim from the server. "Erased" alone
 * invites both wrong readings — that everything is gone (the financial
 * records are not) and that nothing important was (the PII is). The
 * two lists are the honest answer, and the operator can read them back
 * to the data subject.
 */
function EraseReceipt({ result }: { result: EraseCustomerResult }) {
  return (
    <div className="rounded-md border border-default bg-surface-2 p-3 text-xs">
      <div className="flex items-center gap-2 font-medium">
        <Trash2 className="h-3.5 w-3.5 text-danger" />
        Personal data erased {formatDateTime(result.erasedAt)}
      </div>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-fg-subtle">
            Cleared
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {result.fieldsCleared.map((f) => (
              <Badge key={f} variant="muted" className="font-mono text-[10px]">
                {f}
              </Badge>
            ))}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-fg-subtle">
            Retained (legal obligation)
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {result.retainedTables.map((t) => (
              <Badge key={t} variant="muted" className="font-mono text-[10px]">
                {t}
              </Badge>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function EraseDialog({
  customerId,
  onClose,
  onErased,
}: {
  customerId: string;
  onClose: () => void;
  onErased: (r: EraseCustomerResult) => void;
}) {
  const erase = useEraseCustomer();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await erase.mutateAsync({
        customerId,
        reason: reason.trim(),
        acknowledgesRetention: true,
      });
      onErased(r);
    } catch (err) {
      // The 409 for an already-erased customer arrives here with the
      // server's message, which says exactly that.
      toast.error((err as Error).message ?? "Erasure failed");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-danger">
            <AlertTriangle className="h-4 w-4" />
            Erase personal data
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="rounded-md border border-danger/30 bg-danger/[0.06] p-3 text-xs">
            This is irreversible. The customer&apos;s identifying fields — name,
            contact details, IDs, address — are permanently redacted. Financial
            records (loans, payments, the ledger) are retained, as the law
            requires; they will reference an anonymized customer.
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="erase-reason">Reason</Label>
            <Input
              id="erase-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Erasure request DSAR-2026-014, verified 7 Aug"
              required
            />
            <p className="text-[11px] text-fg-subtle">
              At least eight characters. This line is the audit trail&apos;s
              answer to &quot;why was this customer anonymized&quot;.
            </p>
          </div>

          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            <span>
              I understand the financial records are retained and only the
              personal information is erased.
            </span>
          </label>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={erase.isPending}
              disabled={reason.trim().length < 8 || !acknowledged}
            >
              Erase permanently
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Retention policy + purge ───────────────────────────────────────

function RetentionCard() {
  const policy = useRetentionPolicy();
  const update = useUpdateRetentionPolicy();
  const purge = useRunRetentionPurge();
  const toast = useToast();

  const [audit, setAudit] = useState<number | null>(null);
  const [notif, setNotif] = useState<number | null>(null);
  const [jobs, setJobs] = useState<number | null>(null);
  const [purgeResult, setPurgeResult] = useState<RetentionPurgeResult | null>(
    null,
  );

  if (policy.isLoading) return <SkeletonCard />;
  if (!policy.data) return null;
  const p = policy.data;

  // Local edits win until saved; the server value is the fallback.
  const vAudit = audit ?? p.auditRetentionDays;
  const vNotif = notif ?? p.notificationRetentionDays;
  const vJobs = jobs ?? p.jobRunRetentionDays;
  const dirty =
    vAudit !== p.auditRetentionDays ||
    vNotif !== p.notificationRetentionDays ||
    vJobs !== p.jobRunRetentionDays;

  const onSave = async () => {
    try {
      await update.mutateAsync({
        auditRetentionDays: vAudit,
        notificationRetentionDays: vNotif,
        jobRunRetentionDays: vJobs,
      });
      setAudit(null);
      setNotif(null);
      setJobs(null);
      toast.success("Retention policy saved.");
    } catch (err) {
      toast.error((err as Error).message ?? "Could not save the policy");
    }
  };

  const onPurge = async () => {
    try {
      const r = await purge.mutateAsync();
      setPurgeResult(r);
      const total =
        r.deleted.auditEvents + r.deleted.notifications + r.deleted.jobRuns;
      toast.success(`Purge complete — ${total} row(s) deleted.`);
    } catch (err) {
      toast.error((err as Error).message ?? "Purge failed");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Retention policy</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-fg-muted">
          How long operational records are kept before the nightly purge removes
          them. Zero means never purge.
        </p>

        {p.auditBelowAmlaFloor && (
          <div className="flex items-center gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            <AlertTriangle className="h-3.5 w-3.5" />
            The audit window is below the AMLA §9 five-year minimum. Records
            covered by AMLA must be kept at least 1,825 days — this policy will
            purge them earlier.
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <DaysField
            label="Audit events"
            value={vAudit}
            onChange={setAudit}
            sub="AMLA floor: 1,825 days"
          />
          <DaysField
            label="Notifications"
            value={vNotif}
            onChange={setNotif}
            sub="Delivery log"
          />
          <DaysField
            label="Job runs"
            value={vJobs}
            onChange={setJobs}
            sub="Scheduler history"
          />
        </div>

        <div className="flex items-center gap-2">
          <Button onClick={onSave} disabled={!dirty} loading={update.isPending}>
            Save policy
          </Button>
          <Button
            variant="outline"
            onClick={onPurge}
            loading={purge.isPending}
            /*
              Purging against unsaved figures is the trap here: the
              operator lowers a window, clicks purge, and the server
              deletes by the OLD policy — or worse, they think the new
              one applied. Disabled until saved, and labeled with what
              it will actually use.
            */
            disabled={dirty}
            title={
              dirty ? "Save the policy first — purge runs the saved one" : ""
            }
          >
            Run purge now
          </Button>
          {dirty && (
            <span className="text-[11px] text-fg-subtle">
              Purge uses the saved policy — save first.
            </span>
          )}
        </div>

        {purgeResult && (
          <div className="rounded-md border border-default bg-surface-2 p-3 text-xs">
            <div className="font-medium">
              Purge ran {formatDateTime(purgeResult.finishedAt)}
            </div>
            <ul className="mt-1 space-y-0.5 text-fg-muted">
              <li>
                Audit events: {purgeResult.deleted.auditEvents} deleted
                {purgeResult.cutoffs.audit
                  ? ` (before ${formatDateTime(purgeResult.cutoffs.audit)})`
                  : " (window is 0 — never purged)"}
              </li>
              <li>
                Notifications: {purgeResult.deleted.notifications} deleted
                {purgeResult.cutoffs.notification
                  ? ` (before ${formatDateTime(purgeResult.cutoffs.notification)})`
                  : " (window is 0 — never purged)"}
              </li>
              <li>
                Job runs: {purgeResult.deleted.jobRuns} deleted
                {purgeResult.cutoffs.jobRun
                  ? ` (before ${formatDateTime(purgeResult.cutoffs.jobRun)})`
                  : " (window is 0 — never purged)"}
              </li>
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DaysField({
  label,
  value,
  onChange,
  sub,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  sub: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          min={0}
          max={10950}
          value={value}
          onChange={(e) =>
            onChange(Math.max(0, Math.floor(Number(e.target.value) || 0)))
          }
          className="w-28"
        />
        <span className="text-xs text-fg-muted">days</span>
      </div>
      <p className="text-[11px] text-fg-subtle">{sub}</p>
    </div>
  );
}
