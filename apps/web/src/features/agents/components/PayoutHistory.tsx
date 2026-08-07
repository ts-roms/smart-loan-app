import { useAgentPayouts, useVoidAgentPayout } from "@loan/api-client";
import { formatDate, formatMoney } from "@loan/shared-utils";
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
import { Receipt } from "lucide-react";
import { useState, type FormEvent } from "react";

import { usePermission } from "../../../hooks/use-permission";

/**
 * Payouts already made.
 *
 * Voided rows stay, struck through, with their reason. A payout that
 * left the ledger and came back is exactly the thing an audit wants to
 * find, and hiding it would leave the reversal in the books with
 * nothing on the operational side to explain it.
 */
export function PayoutHistory({
  agentId,
  showAgent = true,
}: {
  agentId?: string;
  /** Off when the table is already scoped to one agent on screen. */
  showAgent?: boolean;
}) {
  const canPayout = usePermission("agents.payout");
  const payouts = useAgentPayouts(agentId);
  const [voiding, setVoiding] = useState<string | null>(null);

  if (payouts.isLoading) return <SkeletonCard />;
  const rows = payouts.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Receipt className="h-4 w-4" />
          Payouts
        </CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-4 text-center text-xs text-fg-muted">
            No payouts recorded yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-[10px] uppercase tracking-wider text-fg-subtle">
                <tr>
                  <th className="py-2 px-2 font-medium">Payout</th>
                  {showAgent && (
                    <th className="py-2 px-2 font-medium">Agent</th>
                  )}
                  <th className="py-2 px-2 font-medium">Paid on</th>
                  <th className="py-2 px-2 font-medium">Method</th>
                  <th className="py-2 px-2 font-medium">Loans</th>
                  <th className="py-2 px-2 font-medium text-right">Amount</th>
                  <th className="py-2 px-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-default">
                {rows.map((p) => (
                  <tr
                    key={p.id}
                    className={p.voidedAt ? "opacity-60" : "hover:bg-hover"}
                  >
                    <td className="py-2 px-2 tabular text-xs">
                      {p.number}
                      {p.voidedAt && (
                        <div
                          className="text-[11px] text-danger"
                          title={p.voidReason ?? undefined}
                        >
                          voided {formatDate(p.voidedAt)}
                        </div>
                      )}
                    </td>
                    {showAgent && (
                      <td className="py-2 px-2 text-xs">
                        {p.agentName}
                        <div className="text-[11px] text-fg-muted">
                          {p.agentNumber}
                        </div>
                      </td>
                    )}
                    <td className="py-2 px-2 text-xs text-fg-muted">
                      {formatDate(p.paidOn)}
                    </td>
                    <td className="py-2 px-2 text-xs text-fg-muted">
                      {p.method ?? "—"}
                      {p.reference ? ` · ${p.reference}` : ""}
                    </td>
                    <td className="py-2 px-2 text-xs text-fg-muted">
                      {/*
                        The line items, named. "We paid you ₱14,000" is
                        not an answer to "which of my loans was that
                        for" — this column is.
                      */}
                      <span title={p.items.map((i) => i.loanNumber).join(", ")}>
                        {p.items.length === 0
                          ? "—"
                          : p.items.length <= 2
                            ? p.items.map((i) => i.loanNumber).join(", ")
                            : `${p.items[0]!.loanNumber} +${p.items.length - 1} more`}
                      </span>
                    </td>
                    <td
                      className={
                        "py-2 px-2 text-right tabular " +
                        (p.voidedAt ? "line-through text-fg-subtle" : "")
                      }
                    >
                      {formatMoney(p.amount)}
                    </td>
                    <td className="py-2 px-2 text-right">
                      {p.voidedAt ? (
                        <Badge variant="muted">Voided</Badge>
                      ) : (
                        canPayout && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setVoiding(p.id)}
                          >
                            Void
                          </Button>
                        )
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
      {voiding && <VoidDialog id={voiding} onClose={() => setVoiding(null)} />}
    </Card>
  );
}

function VoidDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const voidPayout = useVoidAgentPayout();
  const toast = useToast();
  const [reason, setReason] = useState("");

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const p = await voidPayout.mutateAsync({ id, reason: reason.trim() });
      toast.success(`${p.number} voided.`);
      onClose();
    } catch (err) {
      toast.error((err as Error).message ?? "Could not void the payout");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Void this payout</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="void-reason">Reason</Label>
            <Input
              id="void-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Paid to the wrong agent"
              required
            />
            <p className="text-[11px] text-fg-subtle">
              {/*
                Not boilerplate. Six months from now this sentence is the
                only account of why a payment left and came back, sitting
                next to a reversal in the general ledger.
              */}
              At least ten characters. This is what the ledger's reversal will
              say, and it is the only record of why.
            </p>
          </div>
          <div className="rounded-md border border-default bg-surface-1 p-3 text-[11px] text-fg-muted">
            The payout stays on record, marked voided, and a reversing entry is
            posted beside the original. Its loans become payable again, so they
            can go on a corrected run.
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={voidPayout.isPending}
              disabled={reason.trim().length < 10}
            >
              Void payout
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
