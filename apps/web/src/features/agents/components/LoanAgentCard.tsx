import { useAgents, useAssignLoanAgent } from "@loan/api-client";
import { formatDate, formatMoney } from "@loan/shared-utils";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useToast,
} from "@loan/ui";
import { Handshake } from "lucide-react";
import { useState } from "react";

import { usePermission } from "../../../hooks/use-permission";

/**
 * Who brought this loan in, and what it pays them.
 *
 * Sits on the loan detail page. Read-only unless the viewer holds
 * `agents.assign` — an officer attributes the loan, but setting what
 * anyone is paid needs `agents.manage` and happens on the agent page.
 */
export function LoanAgentCard({
  loanNumber,
  agentId,
  agentName,
  agentNumber,
  commissionRate,
  commissionAmount,
  commissionPostedAt,
  assignedAt,
}: {
  loanNumber: string;
  agentId: string | null;
  agentName: string | null;
  agentNumber: string | null;
  commissionRate: number | null;
  commissionAmount: number | null;
  commissionPostedAt: string | null;
  assignedAt: string | null;
}) {
  const canAssign = usePermission("agents.assign");
  const assign = useAssignLoanAgent();
  const toast = useToast();
  const [picking, setPicking] = useState(false);

  // Active agents only. A deactivated one would be rejected by the API,
  // so offering them is a trap rather than a choice.
  const agents = useAgents({ active: true, take: 200 });

  /*
   * Once the commission is booked the attribution is frozen. Repointing
   * the loan now would credit the book to someone the money was never
   * promised to, while the ledger still carried a payable to the agent
   * who was. Reversing that is an accounting action, not an edit here.
   */
  const locked = Boolean(commissionPostedAt);

  const doAssign = async (next: string | null) => {
    try {
      await assign.mutateAsync({ loanIdOrNumber: loanNumber, agentId: next });
      toast.success(next ? "Agent assigned." : "Agent removed.");
      setPicking(false);
    } catch (err) {
      toast.error((err as Error).message ?? "Could not assign the agent");
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Handshake className="h-4 w-4" />
          Assisting agent
        </CardTitle>
        {locked && (
          <Badge variant="muted" title="Commission booked at disbursement">
            commission booked
          </Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {agentId ? (
          <div className="rounded-md border border-default bg-surface-1 p-3 text-sm">
            <div className="font-medium">{agentName}</div>
            <div className="text-[11px] text-fg-muted">
              {agentNumber}
              {assignedAt ? ` · assigned ${formatDate(assignedAt)}` : ""}
            </div>
            <div className="mt-2 flex items-baseline justify-between border-t border-default pt-2">
              <span className="text-fg-muted">
                Commission
                {commissionRate !== null
                  ? ` @ ${(commissionRate * 100).toFixed(2)}%`
                  : ""}
              </span>
              <span
                className={
                  commissionPostedAt
                    ? "tabular text-success"
                    : "tabular text-fg-muted"
                }
              >
                {formatMoney(commissionAmount ?? 0)}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-fg-subtle">
              {commissionPostedAt
                ? `Booked ${formatDate(commissionPostedAt)}.`
                : "Payable once this loan is disbursed."}
            </p>
          </div>
        ) : (
          <p className="text-xs text-fg-muted">
            No agent — this application came in directly.
          </p>
        )}

        {canAssign && !locked && (
          <div className="space-y-2">
            {picking ? (
              <>
                <Select
                  onValueChange={(v) =>
                    void doAssign(v === "__none" ? null : v)
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Pick an agent" />
                  </SelectTrigger>
                  <SelectContent>
                    {agentId && (
                      <SelectItem value="__none">— No agent —</SelectItem>
                    )}
                    {(agents.data ?? []).map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name} · {a.number}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPicking(false)}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                loading={assign.isPending}
                onClick={() => setPicking(true)}
              >
                {agentId ? "Change agent" : "Assign an agent"}
              </Button>
            )}
            <p className="text-[11px] text-fg-subtle">
              The rate is taken when you assign and frozen on this loan, so
              later changes to the agent or the product will not move it.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
