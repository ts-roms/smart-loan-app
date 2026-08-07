import { useAgentPayable, useCreateAgentPayout } from "@loan/api-client";
import type { Agent } from "@loan/shared-types";
import { formatDate, formatMoney, todayLocalISO } from "@loan/shared-utils";
import {
  Button,
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
import { useMemo, useState, type FormEvent } from "react";

/**
 * Pay an agent what they are owed.
 *
 * The operator picks which commissions the payment settles rather than
 * "pay everything outstanding". A cashier handing over ₱40,000 against a
 * ₱52,000 balance has to be able to say which loans that covers, and the
 * agent has to be able to read it back — "we paid you ₱40,000 last
 * month" is not an answer to "which of my loans was that for".
 *
 * The amount field is derived from the ticked rows and read-only. The
 * server checks it anyway; this just removes the chance to type a
 * figure that does not match what is being settled.
 */
export function PayoutDialog({
  agent,
  onClose,
}: {
  agent: Agent;
  onClose: () => void;
}) {
  const payable = useAgentPayable(agent.id);
  const create = useCreateAgentPayout();
  const toast = useToast();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [paidOn, setPaidOn] = useState(() => todayLocalISO());
  const [method, setMethod] = useState("CASH");
  const [reference, setReference] = useState("");

  const rows = payable.data?.loans ?? [];
  // Everything ticked by default: paying the whole balance is the common
  // run, and unticking two rows beats ticking eighteen.
  const chosen = useMemo(
    () =>
      selected.size === 0 && rows.length > 0
        ? new Set(rows.map((r) => r.loanId))
        : selected,
    [selected, rows],
  );
  const total = rows
    .filter((r) => chosen.has(r.loanId))
    .reduce((s, r) => s + r.commissionAmount, 0);

  const toggle = (loanId: string) => {
    const next = new Set(chosen);
    if (next.has(loanId)) next.delete(loanId);
    else next.add(loanId);
    // Never empty: an empty set would be read as "default to all" by the
    // memo above and silently re-tick everything the operator just cleared.
    setSelected(next.size === 0 ? new Set(["__none__"]) : next);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const p = await create.mutateAsync({
        agentId: agent.id,
        loanIds: rows.filter((r) => chosen.has(r.loanId)).map((r) => r.loanId),
        amount: Math.round(total * 100) / 100,
        paidOn: new Date(paidOn).toISOString(),
        method: method.trim() || null,
        reference: reference.trim() || null,
      });
      toast.success(`${p.number} — ${formatMoney(p.amount)} paid.`);
      onClose();
    } catch (err) {
      // The API's messages name the loan or the figure at fault, so they
      // go through unchanged rather than being replaced with a generic.
      toast.error((err as Error).message ?? "Could not record the payout");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            Pay {agent.name} · {agent.number}
          </DialogTitle>
        </DialogHeader>

        {payable.isLoading ? (
          <SkeletonCard />
        ) : rows.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-sm text-fg-muted">
              Nothing outstanding for this agent.
            </p>
            <p className="mt-1 text-[11px] text-fg-subtle">
              A commission becomes payable when the loan is disbursed.
              {payable.data?.paidTotal
                ? ` ${formatMoney(payable.data.paidTotal)} has already been paid.`
                : ""}
            </p>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="max-h-72 overflow-y-auto rounded-md border border-default">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-surface-2 text-left text-[10px] uppercase tracking-wider text-fg-subtle">
                  <tr>
                    <th className="py-2 px-2 font-medium" />
                    <th className="py-2 px-2 font-medium">Loan</th>
                    <th className="py-2 px-2 font-medium">Borrower</th>
                    <th className="py-2 px-2 font-medium">Earned</th>
                    <th className="py-2 px-2 font-medium text-right">
                      Commission
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-default">
                  {rows.map((r) => (
                    <tr key={r.loanId} className="hover:bg-hover">
                      <td className="py-2 px-2">
                        <input
                          type="checkbox"
                          aria-label={`Include ${r.loanNumber}`}
                          checked={chosen.has(r.loanId)}
                          onChange={() => toggle(r.loanId)}
                        />
                      </td>
                      <td className="py-2 px-2 tabular text-xs">
                        {r.loanNumber}
                      </td>
                      <td className="py-2 px-2 text-xs">{r.customerName}</td>
                      <td className="py-2 px-2 text-xs text-fg-muted">
                        {formatDate(r.postedAt)}
                      </td>
                      <td className="py-2 px-2 text-right tabular">
                        {formatMoney(r.commissionAmount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="po-date">Paid on</Label>
                <Input
                  id="po-date"
                  type="date"
                  value={paidOn}
                  onChange={(e) => setPaidOn(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="po-method">Method</Label>
                <Input
                  id="po-method"
                  value={method}
                  onChange={(e) => setMethod(e.target.value)}
                  placeholder="CASH, BANK_TRANSFER, GCASH"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="po-ref">Reference</Label>
                <Input
                  id="po-ref"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  placeholder="Optional"
                />
              </div>
            </div>

            <div className="rounded-md border border-default bg-surface-1 p-3">
              <div className="flex items-baseline justify-between">
                <span className="text-fg-muted">
                  Paying {rows.filter((r) => chosen.has(r.loanId)).length} of{" "}
                  {rows.length} outstanding
                </span>
                <span className="text-lg font-semibold tabular">
                  {formatMoney(total)}
                </span>
              </div>
              <p className="mt-2 border-t border-default pt-2 text-[11px] text-fg-subtle">
                {/*
                  Says what the entry does, because a payout is the one
                  place in this feature where cash actually moves and
                  the operator should know which accounts it touches.
                */}
                Posts Dr Agent Commission Payable / Cr Cash. The expense was
                already recognized when each loan was disbursed, so this only
                takes the liability down.
              </p>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                loading={create.isPending}
                disabled={total <= 0}
              >
                Pay {formatMoney(total)}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
