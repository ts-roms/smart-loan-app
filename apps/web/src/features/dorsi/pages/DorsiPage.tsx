import {
  useDeactivateDorsi,
  useDorsiRegister,
  useDorsiSystemConfig,
  useDorsiUtilization,
  useMyPermissions,
  useReviewDorsi,
  useTagDorsi,
  useUpdateSystemConfig,
} from "@loan/api-client";
import type { DorsiCategory } from "@loan/shared-types";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SkeletonCard,
  cn,
  useConfirm,
  usePrompt,
  useToast,
} from "@loan/ui";
import { formatDate, formatDateTime, formatMoney } from "@loan/shared-utils";
import {
  AlertTriangle,
  CheckCircle2,
  Edit3,
  Gavel,
  Scale,
  ShieldAlert,
  ShieldCheck,
  UserPlus,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { CustomerPicker } from "../../../components/CustomerPicker";
import { findArticle, TourButton } from "../../help";

const CATEGORY_LABEL: Record<DorsiCategory, string> = {
  DIRECTOR: "Director",
  OFFICER: "Officer",
  STOCKHOLDER: "Stockholder",
  RELATED_INTEREST: "Related interest",
};

/**
 * DORSI page. Three sections:
 *   1. Utilization dashboard (aggregate gauge + threshold alerts)
 *   2. Register (active DORSI customers, tag/deactivate/review)
 *   3. System config (company total equity, the cap base)
 *
 * Naming: DORSI (not DOSRI), no company-brand strings hard-coded.
 */
export function DorsiPage() {
  const me = useMyPermissions();
  const perms = new Set(me.data?.permissions ?? []);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Scale className="h-4 w-4 text-sky-300" />
            DORSI compliance
          </CardTitle>
          <TourButton tourId="dorsi" steps={findArticle("dorsi")?.tour ?? []} />
        </CardHeader>
        <CardContent>
          <p className="text-xs text-white/55">
            loans to Directors / Officers / Stockholders / Related Interests are
            capped at 15% of Company Total Equity in aggregate, with no single
            DORSI borrower exceeding 30% of that aggregate cap. Loans that would
            breach either cap require board approval before disburse.
          </p>
        </CardContent>
      </Card>

      <UtilizationCard />
      <RegisterCard perms={perms} />
      {perms.has("admin.system_config") && <ConfigCard />}
    </div>
  );
}

function UtilizationCard() {
  const u = useDorsiUtilization();
  if (u.isLoading) return <SkeletonCard />;
  if (!u.data) return null;

  const aggPct = u.data.aggregateUtilizationPct;
  const alert =
    aggPct >= 1
      ? "breach"
      : aggPct >= 0.9
        ? "critical"
        : aggPct >= 0.8
          ? "warning"
          : null;

  return (
    <Card data-tour="dorsi-utilization">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <ShieldCheck className="h-4 w-4" />
          Utilization
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {alert && (
          <div
            className={cn(
              "rounded-md border px-3 py-2 text-xs flex items-center gap-2",
              alert === "breach"
                ? "border-rose-400/40 bg-rose-400/10 text-rose-100"
                : alert === "critical"
                  ? "border-rose-400/30 bg-rose-400/[0.06] text-rose-200"
                  : "border-amber-400/40 bg-amber-400/10 text-amber-100",
            )}
          >
            <AlertTriangle className="h-3 w-3" />
            {alert === "breach" &&
              `DORSI aggregate cap BREACHED — total outstanding ${formatMoney(u.data.aggregateOutstanding)} exceeds the 15% limit (${formatMoney(u.data.aggregateCap)}). Stop new DORSI disbursements until restored.`}
            {alert === "critical" &&
              `DORSI aggregate utilization at ${(aggPct * 100).toFixed(1)}% — within 10% of the cap.`}
            {alert === "warning" &&
              `DORSI aggregate utilization at ${(aggPct * 100).toFixed(1)}% — approaching the cap.`}
          </div>
        )}

        <div className="grid grid-cols-3 gap-2">
          <Stat
            label="Company total equity"
            value={formatMoney(u.data.companyTotalEquity)}
            sub="Cap base"
          />
          <Stat
            label="Aggregate cap (15%)"
            value={formatMoney(u.data.aggregateCap)}
          />
          <Stat
            label="Individual cap (30% of agg.)"
            value={formatMoney(u.data.individualCap)}
            sub="Per single DORSI borrower"
          />
        </div>

        {/* Utilization gauge */}
        <div>
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-white/55">
              Aggregate outstanding · {formatMoney(u.data.aggregateOutstanding)}
            </span>
            <span
              className={cn(
                "font-mono",
                aggPct >= 1
                  ? "text-rose-300"
                  : aggPct >= 0.9
                    ? "text-rose-200"
                    : aggPct >= 0.8
                      ? "text-amber-200"
                      : "text-emerald-300",
              )}
            >
              {(aggPct * 100).toFixed(1)}%
            </span>
          </div>
          <div className="h-2 rounded-full bg-white/[0.06] overflow-hidden">
            <div
              className={cn(
                "h-full transition-all",
                aggPct >= 1
                  ? "bg-rose-400"
                  : aggPct >= 0.9
                    ? "bg-rose-300"
                    : aggPct >= 0.8
                      ? "bg-amber-300"
                      : "bg-emerald-400",
              )}
              style={{ width: `${Math.min(100, aggPct * 100)}%` }}
            />
          </div>
        </div>

        {/* Per-borrower breakdown */}
        {u.data.perBorrower.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-white/45 mb-1.5">
              Per-borrower exposure ({u.data.perBorrower.length})
            </div>
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-white/45">
                <tr>
                  <th className="py-2 px-2">Borrower</th>
                  <th className="py-2 px-2">Category</th>
                  <th className="py-2 px-2 text-right">Outstanding</th>
                  <th className="py-2 px-2 text-right">Utilization</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {u.data.perBorrower.map((b) => (
                  <tr key={b.customerId} className="hover:bg-white/[0.03]">
                    <td className="py-2 px-2 text-xs">
                      <Link
                        to={`/customers/${b.customerNumber}`}
                        className="text-sky-300 hover:underline"
                      >
                        {b.customerName}
                      </Link>
                      <div className="text-[10px] font-mono text-fg-subtle mt-0.5">
                        {b.customerNumber}
                      </div>
                    </td>
                    <td className="py-2 px-2">
                      <Badge variant="muted">
                        {CATEGORY_LABEL[b.category]}
                      </Badge>
                    </td>
                    <td className="py-2 px-2 text-right font-mono text-xs">
                      {formatMoney(b.outstanding)}
                    </td>
                    <td
                      className={cn(
                        "py-2 px-2 text-right font-mono text-xs",
                        b.utilizationPct >= 1
                          ? "text-rose-300"
                          : b.utilizationPct >= 0.8
                            ? "text-amber-300"
                            : "text-emerald-300",
                      )}
                    >
                      {(b.utilizationPct * 100).toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RegisterCard({ perms }: { perms: Set<string> }) {
  const register = useDorsiRegister();
  const [tagOpen, setTagOpen] = useState(false);
  const review = useReviewDorsi();
  const deactivate = useDeactivateDorsi();
  const toast = useToast();
  const confirm = useConfirm();
  const askPrompt = usePrompt();

  const onReview = async (id: string) => {
    try {
      await review.mutateAsync(id);
      toast.success("Marked reviewed");
    } catch (err) {
      toast.error((err as Error).message ?? "Review failed");
    }
  };

  const onDeactivate = async (id: string, customerName: string) => {
    const reason = await askPrompt({
      title: "Deactivate DORSI tag",
      message: `Removing ${customerName}'s DORSI tag — the customer will no longer count toward the 15%/30% caps. Reason for the audit trail?`,
      label: "Reason",
      placeholder: "Resigned from board / sold shares / etc.",
      confirmLabel: "Deactivate",
    });
    if (reason === null) return;
    const ok = await confirm({
      title: "Confirm deactivate?",
      message:
        "This frees up cap headroom but is reversible — tagging the customer again restores the record.",
      confirmLabel: "Deactivate",
      tone: "destructive",
    });
    if (!ok) return;
    try {
      await deactivate.mutateAsync({ id, reason });
      toast.success("DORSI tag deactivated");
    } catch (err) {
      toast.error((err as Error).message ?? "Deactivate failed");
    }
  };

  return (
    <Card data-tour="dorsi-register">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm">Register</CardTitle>
        {perms.has("dorsi.tag") && (
          <Button size="sm" onClick={() => setTagOpen(true)}>
            <UserPlus className="h-3 w-3" />
            Tag customer
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {register.isLoading ? (
          <SkeletonCard />
        ) : (register.data ?? []).length === 0 ? (
          <p className="text-sm text-white/55">No active DORSI records.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-white/45">
              <tr>
                <th className="py-2 px-2">Customer</th>
                <th className="py-2 px-2">Category</th>
                <th className="py-2 px-2">Basis</th>
                <th className="py-2 px-2">Tagged</th>
                <th className="py-2 px-2">Last review</th>
                {perms.has("dorsi.tag") && (
                  <th className="py-2 px-2 text-right">Actions</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {register.data!.map((r) => (
                <tr key={r.id} className="hover:bg-white/[0.03]">
                  <td className="py-2 px-2 text-xs">
                    <Link
                      to={`/customers/${r.customer.number}`}
                      className="text-sky-300 hover:underline"
                    >
                      {r.customer.firstName} {r.customer.lastName}
                    </Link>
                    <div className="text-[10px] font-mono text-fg-subtle mt-0.5">
                      {r.customer.number}
                    </div>
                  </td>
                  <td className="py-2 px-2">
                    <Badge variant="muted">{CATEGORY_LABEL[r.category]}</Badge>
                  </td>
                  <td className="py-2 px-2 text-xs text-white/75 max-w-xs truncate">
                    {r.basis}
                  </td>
                  <td className="py-2 px-2 text-[10px] text-white/55">
                    {formatDateTime(r.taggedAt)}
                  </td>
                  <td className="py-2 px-2 text-[10px] text-white/55">
                    {r.lastReviewedAt ? formatDate(r.lastReviewedAt) : "—"}
                  </td>
                  {perms.has("dorsi.tag") && (
                    <td className="py-2 px-2 text-right">
                      <div className="inline-flex gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => onReview(r.id)}
                        >
                          <CheckCircle2 className="h-3 w-3" />
                          Review
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            onDeactivate(
                              r.id,
                              `${r.customer.firstName} ${r.customer.lastName}`,
                            )
                          }
                        >
                          <XCircle className="h-3 w-3" />
                        </Button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>

      {tagOpen && <TagDialog onClose={() => setTagOpen(false)} />}
    </Card>
  );
}

function ConfigCard() {
  const cfg = useDorsiSystemConfig();
  const update = useUpdateSystemConfig();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(0);

  const startEdit = () => {
    setValue(cfg.data?.companyTotalEquity ?? 0);
    setEditing(true);
  };

  const onSave = async () => {
    if (value < 0) {
      toast.error("Equity must be ≥ 0");
      return;
    }
    try {
      await update.mutateAsync({ companyTotalEquity: value });
      toast.success(`Company total equity set to ${formatMoney(value)}`);
      setEditing(false);
    } catch (err) {
      toast.error((err as Error).message ?? "Save failed");
    }
  };

  return (
    <Card data-tour="dorsi-config">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm flex items-center gap-2">
          <Gavel className="h-4 w-4" />
          System config
        </CardTitle>
        {!editing && (
          <Button size="sm" variant="outline" onClick={startEdit}>
            <Edit3 className="h-3 w-3" />
            Edit equity
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {cfg.isLoading ? (
          <SkeletonCard />
        ) : editing ? (
          <div className="space-y-2">
            <div>
              <Label>Company total equity (₱)</Label>
              <Input
                type="number"
                step="0.01"
                min={0}
                value={value || ""}
                onChange={(e) => setValue(Number(e.target.value))}
              />
            </div>
            <div className="flex gap-2 justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
              <Button size="sm" onClick={onSave} disabled={update.isPending}>
                {update.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="text-xs text-white/55 mb-1">
              Company total equity
            </div>
            <div className="font-mono text-2xl text-white">
              {formatMoney(cfg.data?.companyTotalEquity ?? 0)}
            </div>
            <p className="text-[10px] text-white/45 mt-2">
              Base for the 15% aggregate DORSI cap and the 30% individual cap.
              Update on the books each quarter so the caps stay in sync with the
              latest balance sheet.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function TagDialog({ onClose }: { onClose: () => void }) {
  const tag = useTagDorsi();
  const toast = useToast();
  const [customerId, setCustomerId] = useState("");
  const [category, setCategory] = useState<DorsiCategory>("OFFICER");
  const [basis, setBasis] = useState("");

  const onSubmit = async () => {
    if (!customerId || basis.trim().length < 3) {
      toast.error("Customer id + basis required");
      return;
    }
    try {
      await tag.mutateAsync({ customerId, category, basis: basis.trim() });
      toast.success("Customer tagged");
      onClose();
    } catch (err) {
      toast.error((err as Error).message ?? "Tag failed");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tag DORSI customer</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-white/55 inline-flex items-center gap-1">
            <ShieldAlert className="h-3 w-3 text-amber-300" />
            Tagged customers count toward the 15% aggregate cap and the 30%
            individual cap. Re-tag an existing record to update category or
            basis.
          </p>
          <div>
            <Label>Customer</Label>
            <CustomerPicker
              value={customerId}
              onChange={setCustomerId}
              placeholder="Search by name, CUST-…, or ID number"
            />
            <div className="text-[10px] text-fg-subtle mt-1">
              Start typing to find an existing customer record. Re-tagging an
              already-tagged customer updates their category and basis.
            </div>
          </div>
          <div>
            <Label>Category</Label>
            <Select
              value={category}
              onValueChange={(v) => setCategory(v as DorsiCategory)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(
                  Object.entries(CATEGORY_LABEL) as Array<
                    [DorsiCategory, string]
                  >
                ).map(([k, v]) => (
                  <SelectItem key={k} value={k}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Basis</Label>
            <Input
              value={basis}
              onChange={(e) => setBasis(e.target.value)}
              placeholder="Director since 2022 / CFO / Spouse of stockholder"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={tag.isPending}>
            {tag.isPending ? "Tagging…" : "Tag customer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-md border border-white/10 bg-white/[0.03] p-3">
      <div className="text-[10px] uppercase tracking-wider text-white/45">
        {label}
      </div>
      <div className="font-mono text-sm mt-1">{value}</div>
      {sub && <div className="text-[10px] text-white/45 mt-0.5">{sub}</div>}
    </div>
  );
}
