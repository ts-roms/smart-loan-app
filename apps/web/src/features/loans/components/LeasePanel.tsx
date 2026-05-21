import {
  useBuyoutLease,
  useExtendLease,
  useLease,
  useMyPermissions,
  usePullOutLease,
  useReturnLease,
} from "@loan/api-client";
import type { LeaseStatus } from "@loan/shared-types";
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
  SkeletonLine,
  cn,
  usePrompt,
  useToast,
} from "@loan/ui";
import { formatDateTime, formatMoney } from "@loan/shared-utils";
import { JournalEntryLink } from "../../accounting";
import {
  AlertTriangle,
  Car,
  CheckCircle2,
  Gavel,
  LogOut,
  Repeat,
} from "lucide-react";
import { useState } from "react";

const STATUS_LABEL: Record<LeaseStatus, string> = {
  ACTIVE: "Active",
  PULLED_OUT: "Pulled out",
  BUYOUT_COMPLETED: "Buyout completed",
  RETURNED: "Returned",
  EXTENDED: "Extended",
};

const STATUS_VARIANT: Record<
  LeaseStatus,
  "muted" | "success" | "warning" | "danger"
> = {
  ACTIVE: "muted",
  PULLED_OUT: "danger",
  BUYOUT_COMPLETED: "success",
  RETURNED: "success",
  EXTENDED: "warning",
};

/**
 * Lease-to-Own panel — FRD §3.5. Renders on a loan detail page only when
 * the loan has a LeaseAgreement attached. Shows residual + title holder +
 * missed-payment streak, plus the four terminal transitions (buyout,
 * pull-out, return, extend).
 */
export function LeasePanel({ loanId }: { loanId: string }) {
  const lease = useLease(loanId);
  const me = useMyPermissions();
  const perms = new Set(me.data?.permissions ?? []);

  // 404 (no lease) returns null/undefined data — silently render nothing.
  if (lease.isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Car className="h-4 w-4" />
            Lease agreement
          </CardTitle>
        </CardHeader>
        <CardContent>
          <SkeletonLine />
        </CardContent>
      </Card>
    );
  }
  if (!lease.data) return null;
  const l = lease.data;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm flex items-center gap-2">
          <Car className="h-4 w-4 text-sky-300" />
          Lease agreement
        </CardTitle>
        <div className="flex items-center gap-2">
          <Badge variant={STATUS_VARIANT[l.status]}>
            {STATUS_LABEL[l.status]}
          </Badge>
          <Badge variant={l.titleHolder === "CUSTOMER" ? "success" : "muted"}>
            Title · {l.titleHolder.toLowerCase()}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {l.status === "PULLED_OUT" && (
          <div className="rounded-md border border-rose-400/40 bg-rose-400/10 px-3 py-2 text-xs text-rose-100 flex items-center gap-2">
            <AlertTriangle className="h-3 w-3" />
            Vehicle pulled out — drive the recovery via the Repossession
            workflow. Reason: {l.pullOutReason}
          </div>
        )}
        {l.status === "ACTIVE" && l.missedPaymentStreak >= 2 && (
          <div className="rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-100 flex items-center gap-2">
            <AlertTriangle className="h-3 w-3" />
            {l.missedPaymentStreak} consecutive missed payment(s). One more and
            (for non-employees) the vehicle is eligible for pull-out per FRD
            §3.5.
          </div>
        )}

        <div className="grid grid-cols-3 gap-2">
          <Stat
            label="Residual buyout"
            value={formatMoney(Number(l.residualValue))}
          />
          <Stat
            label="Borrower type"
            value={l.isEmployee ? "Employee" : "Non-employee"}
            sub={
              l.isEmployee ? "Pull-out not applicable" : "Pull-out at 3+ misses"
            }
          />
          <Stat
            label="Missed streak"
            value={String(l.missedPaymentStreak)}
            sub="Resets on payment"
            accent={l.missedPaymentStreak >= 2 ? "rose" : undefined}
          />
        </div>

        {l.status === "BUYOUT_COMPLETED" && (
          <div className="rounded-md border border-emerald-400/30 bg-emerald-400/10 p-2.5 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-white/85">
                <CheckCircle2 className="inline h-3 w-3 mr-1 text-emerald-300" />
                Buyout completed ·{" "}
                {formatMoney(Number(l.buyoutPaidAmount ?? 0))} on{" "}
                {l.buyoutAt ? formatDateTime(l.buyoutAt) : ""}
              </span>
              {l.buyoutJournalEntryId && (
                <JournalEntryLink id={l.buyoutJournalEntryId}>
                  <Badge variant="success">JE</Badge>
                </JournalEntryLink>
              )}
            </div>
          </div>
        )}

        {l.closedReason && (
          <div className="text-[10px] text-white/55">
            Closure reason: {l.closedReason}
          </div>
        )}

        {l.status === "ACTIVE" && <ActiveActions agreement={l} perms={perms} />}
      </CardContent>
    </Card>
  );
}

function ActiveActions({
  agreement,
  perms,
}: {
  agreement: {
    id: string;
    loanId: string;
    isEmployee: boolean;
    residualValue: string | number;
  };
  perms: Set<string>;
}) {
  const [buyoutOpen, setBuyoutOpen] = useState(false);
  const pull = usePullOutLease();
  const ret = useReturnLease();
  const ext = useExtendLease();
  const toast = useToast();
  const askPrompt = usePrompt();

  const onPullOut = async () => {
    const reason = await askPrompt({
      title: "Pull out leased vehicle",
      message:
        "Non-employee borrower with 3+ consecutive missed payments. The Repossession workflow handles the actual vehicle recovery — this just marks the lease as pulled-out.",
      label: "Reason",
      placeholder:
        "e.g. 3 consecutive missed payments; demand letter unresponded",
      confirmLabel: "Pull out",
    });
    if (reason === null) return;
    try {
      await pull.mutateAsync({ loanId: agreement.loanId, reason });
      toast.success("Lease marked as pulled-out");
    } catch (err) {
      toast.error((err as Error).message ?? "Pull-out failed");
    }
  };

  const onReturn = async () => {
    const reason = await askPrompt({
      title: "Borrower returned the vehicle",
      message:
        "End-of-term return option. The vehicle goes back to the company.",
      label: "Reason / notes",
      placeholder: "Returned at end of lease term, vehicle in good condition",
      confirmLabel: "Mark returned",
    });
    if (reason === null) return;
    try {
      await ret.mutateAsync({ loanId: agreement.loanId, reason });
      toast.success("Lease marked as returned");
    } catch (err) {
      toast.error((err as Error).message ?? "Return failed");
    }
  };

  const onExtend = async () => {
    const reason = await askPrompt({
      title: "Extend lease",
      message: "Mark as extended for a further term per agreement.",
      label: "Reason / new term",
      placeholder: "Extended for 12 more months at same rate",
      confirmLabel: "Extend",
    });
    if (reason === null) return;
    try {
      await ext.mutateAsync({ loanId: agreement.loanId, reason });
      toast.success("Lease extended");
    } catch (err) {
      toast.error((err as Error).message ?? "Extend failed");
    }
  };

  const buttons: React.ReactNode[] = [];
  if (perms.has("lease.buyout")) {
    buttons.push(
      <Button key="buyout" size="sm" onClick={() => setBuyoutOpen(true)}>
        <Gavel className="h-3 w-3" />
        Buyout
      </Button>,
    );
  }
  if (perms.has("lease.close")) {
    buttons.push(
      <Button key="return" size="sm" variant="outline" onClick={onReturn}>
        <LogOut className="h-3 w-3" />
        Return
      </Button>,
      <Button key="extend" size="sm" variant="outline" onClick={onExtend}>
        <Repeat className="h-3 w-3" />
        Extend
      </Button>,
    );
  }
  if (perms.has("lease.pull_out") && !agreement.isEmployee) {
    buttons.push(
      <Button key="pull-out" size="sm" variant="outline" onClick={onPullOut}>
        <AlertTriangle className="h-3 w-3" />
        Pull out
      </Button>,
    );
  }

  return (
    <>
      <div className="flex gap-1 flex-wrap">{buttons}</div>
      {buyoutOpen && (
        <BuyoutDialog
          loanId={agreement.loanId}
          residual={Number(agreement.residualValue)}
          onClose={() => setBuyoutOpen(false)}
        />
      )}
    </>
  );
}

function BuyoutDialog({
  loanId,
  residual,
  onClose,
}: {
  loanId: string;
  residual: number;
  onClose: () => void;
}) {
  const buyout = useBuyoutLease();
  const toast = useToast();
  const [amount, setAmount] = useState(residual);

  const onSubmit = async () => {
    if (amount <= 0) {
      toast.error("Amount must be > 0");
      return;
    }
    try {
      await buyout.mutateAsync({ loanId, amountPaid: amount });
      toast.success(`Buyout posted — title transferred to borrower`);
      onClose();
    } catch (err) {
      toast.error((err as Error).message ?? "Buyout failed");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Residual buyout</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-white/55">
            Borrower pays the residual fee to take title. Posts a Dr Cash / Cr
            Lease Income entry, marks the lease as BUYOUT_COMPLETED, and closes
            the loan.
          </p>
          <div>
            <Label>Amount paid (₱) — residual {formatMoney(residual)}</Label>
            <Input
              type="number"
              step="0.01"
              min={0.01}
              value={amount || ""}
              onChange={(e) => setAmount(Number(e.target.value))}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={buyout.isPending}>
            {buyout.isPending ? "Posting…" : "Post buyout"}
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
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: "rose";
}) {
  const color = accent === "rose" ? "text-rose-300" : "text-white";
  return (
    <div className="rounded-md border border-white/10 bg-white/[0.03] p-2">
      <div className="text-[10px] uppercase tracking-wider text-white/45">
        {label}
      </div>
      <div className={cn("font-mono text-sm mt-0.5", color)}>{value}</div>
      {sub && <div className="text-[10px] text-white/45 mt-0.5">{sub}</div>}
    </div>
  );
}
