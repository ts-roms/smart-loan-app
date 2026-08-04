import {
  useLoanPenalties,
  useLoanPenaltyWaivers,
  useMyPermissions,
  useWaivePenalty,
} from "@loan/api-client";
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
  useToast,
} from "@loan/ui";
import { formatDateTime, formatMoney } from "@loan/shared-utils";
import { JournalEntryLink } from "../../accounting";
import { AlertTriangle, Gavel, ScrollText } from "lucide-react";
import { useState } from "react";

/**
 * Penalty Panel "Facility to Waive Penalties".
 *
 * Shows: total accrued late-fees, total waived-to-date, current outstanding.
 * Gated waive button opens a dialog (amount + reason) which posts a
 * reversing journal entry and snapshots the waiver row. History of prior
 * waivers is listed with each row's original vs negotiated amounts and
 * a link to the GL reversal entry.
 *
 * Only rendered when the loan has at least some accrued penalty on the
 * books — keeps the loan detail page clean for performing loans.
 */
export function PenaltyPanel({ loanId }: { loanId: string }) {
  const penalties = useLoanPenalties(loanId);
  const waivers = useLoanPenaltyWaivers(loanId);
  const me = useMyPermissions();
  const canWaive = (me.data?.permissions ?? []).includes("loans.waive_penalty");
  const [open, setOpen] = useState(false);

  // Hide the whole panel when there's no penalty signal at all — keeps
  // the loan detail page tidy for borrowers who pay on time.
  const hasAnyPenalty =
    penalties.data &&
    (penalties.data.originalPenalty > 0 || (waivers.data ?? []).length > 0);
  if (!penalties.isLoading && !hasAnyPenalty) return null;

  const outstanding = penalties.data?.outstanding ?? 0;
  const original = penalties.data?.originalPenalty ?? 0;
  const waived = penalties.data?.waivedToDate ?? 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-warning" />
          Late-fee penalties
        </CardTitle>
        {canWaive && outstanding > 0 && (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            <Gavel className="h-3 w-3" />
            Waive penalties
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {penalties.isLoading ? (
          <SkeletonLine />
        ) : (
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Total accrued" value={formatMoney(original)} />
            <Stat
              label="Waived to date"
              value={formatMoney(waived)}
              accent="emerald"
            />
            <Stat
              label="Outstanding"
              value={formatMoney(outstanding)}
              accent={outstanding > 0 ? "amber" : "emerald"}
            />
          </div>
        )}

        {/* Waiver history */}
        {(waivers.data ?? []).length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider text-fg-subtle mb-1.5 flex items-center gap-1">
              <ScrollText className="h-3 w-3" />
              Waiver history
            </div>
            <div className="rounded-md border border-default bg-surface-2 divide-y divide-default">
              {(waivers.data ?? []).map((w) => (
                <div key={w.id} className="px-2.5 py-2 text-xs">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-semibold text-danger">
                        -{formatMoney(Number(w.waivedAmount))}
                      </span>
                      <span className="text-fg-subtle text-[10px]">
                        ({formatMoney(Number(w.originalPenalty))} →{" "}
                        {formatMoney(Number(w.negotiatedPenalty))})
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-fg-subtle">
                      <span>{formatDateTime(w.waivedAt)}</span>
                      {w.journalEntryId && (
                        <JournalEntryLink id={w.journalEntryId}>
                          <Badge variant="success">JE</Badge>
                        </JournalEntryLink>
                      )}
                    </div>
                  </div>
                  <div className="mt-1 text-fg-muted">{w.reason}</div>
                  {w.waivedBy && (
                    <div className="mt-0.5 text-[10px] text-fg-subtle">
                      by {w.waivedBy.name}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>

      {open && (
        <WaiveDialog
          loanId={loanId}
          maxAmount={outstanding}
          onClose={() => setOpen(false)}
        />
      )}
    </Card>
  );
}

function WaiveDialog({
  loanId,
  maxAmount,
  onClose,
}: {
  loanId: string;
  maxAmount: number;
  onClose: () => void;
}) {
  const waive = useWaivePenalty();
  const toast = useToast();
  const [amount, setAmount] = useState(maxAmount);
  const [reason, setReason] = useState("");

  const onSubmit = async () => {
    if (amount <= 0 || amount > maxAmount + 0.005) {
      toast.error(`Amount must be between 0.01 and ${maxAmount.toFixed(2)}`);
      return;
    }
    if (reason.trim().length < 3) {
      toast.error("Reason required (≥ 3 characters)");
      return;
    }
    try {
      const result = await waive.mutateAsync({
        loanId,
        waivedAmount: amount,
        reason: reason.trim(),
      });
      toast.success(
        `Waived ${formatMoney(amount)}. Negotiated penalty: ${formatMoney(result.waiver.negotiatedPenalty)}.`,
      );
      onClose();
    } catch (err) {
      toast.error((err as Error).message ?? "Waive failed");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Waive penalties</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-fg-muted">
            Outstanding penalty:{" "}
            <span className="font-mono text-fg">{formatMoney(maxAmount)}</span>.
            Waiving posts a reversing journal entry and snapshots the original
            vs negotiated amounts for future audit.
          </p>
          <div>
            <Label>Waive amount (₱)</Label>
            <Input
              type="number"
              step="0.01"
              min={0.01}
              max={maxAmount}
              value={amount || ""}
              onChange={(e) => setAmount(Number(e.target.value))}
            />
          </div>
          <div>
            <Label>Reason (required, ≥ 3 chars)</Label>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Goodwill — long-standing customer; settled in full"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={onSubmit}
            disabled={
              waive.isPending || amount <= 0 || reason.trim().length < 3
            }
          >
            {waive.isPending ? "Waiving…" : "Waive & post reversal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "amber" | "emerald";
}) {
  const color =
    accent === "amber"
      ? "text-warning"
      : accent === "emerald"
        ? "text-success"
        : "text-fg";
  return (
    <div className="rounded-md border border-default bg-surface-2 p-2">
      <div className="text-[10px] uppercase tracking-wider text-fg-subtle">
        {label}
      </div>
      <div className={`font-mono text-sm mt-0.5 ${color}`}>{value}</div>
    </div>
  );
}
