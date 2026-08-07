import {
  useAgentBook,
  useAgentPayable,
  useAgents,
  useCreateAgent,
  useUpdateAgent,
  useUsers,
} from "@loan/api-client";
import type { Agent } from "@loan/shared-types";
import { formatMoney } from "@loan/shared-utils";
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
  useToast,
} from "@loan/ui";
import { Banknote, Search, UserPlus, X } from "lucide-react";
import { useState, type FormEvent } from "react";

import { usePermission } from "../../../hooks/use-permission";
import { AgentBookTable } from "../components/AgentBookTable";
import { AgentStats } from "../components/AgentStats";
import { PayoutDialog } from "../components/PayoutDialog";
import { PayoutHistory } from "../components/PayoutHistory";

/**
 * The agent directory, and a drill-down into any one agent's book.
 *
 * Rates are entered and displayed as PERCENTAGES here and stored as
 * fractions. Nobody quotes a colleague "0.02", and the one place that
 * mismatch is dangerous — an officer typing 2 and meaning 2% — is
 * exactly what the API's ceiling rejects. Converting at the edge means
 * the field can say "%" and the wire can stay a fraction.
 */
export function AgentsPage() {
  const canManage = usePermission("agents.manage");
  const canPayout = usePermission("agents.payout");
  const [q, setQ] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Agent | null>(null);
  const [openBook, setOpenBook] = useState<Agent | null>(null);
  const [paying, setPaying] = useState<Agent | null>(null);

  const agents = useAgents({
    q: q.trim() || undefined,
    active: showInactive ? undefined : true,
  });
  const rows = agents.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Agents</h1>
          <p className="text-xs text-fg-muted">
            Field originators and what they have earned.
          </p>
        </div>
        {canManage && (
          <Button onClick={() => setCreating(true)}>
            <UserPlus className="mr-1.5 h-4 w-4" />
            Register an agent
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" />
          <Input
            className="w-64 pl-8"
            placeholder="Number, name, email or territory"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <Button
          variant={showInactive ? "default" : "outline"}
          size="sm"
          onClick={() => setShowInactive((v) => !v)}
        >
          {showInactive ? "Showing inactive" : "Active only"}
        </Button>
      </div>

      {agents.isLoading ? (
        <SkeletonCard />
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-fg-muted">
            No agents{q ? " match that search" : " yet"}.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-[10px] uppercase tracking-wider text-fg-subtle">
                <tr>
                  <th className="py-2 px-2 font-medium">Agent</th>
                  <th className="py-2 px-2 font-medium">Territory</th>
                  <th className="py-2 px-2 font-medium text-right">Rate</th>
                  <th className="py-2 px-2 font-medium text-right">Funded</th>
                  <th className="py-2 px-2 font-medium text-right">Earned</th>
                  <th className="py-2 px-2 font-medium text-right">Owed now</th>
                  <th className="py-2 px-2 font-medium text-right">Pipeline</th>
                  <th className="py-2 px-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-default">
                {rows.map((a) => (
                  <tr key={a.id} className="hover:bg-hover">
                    <td className="py-2 px-2">
                      <button
                        type="button"
                        onClick={() => setOpenBook(a)}
                        className="text-left"
                      >
                        <div className="font-medium text-primary hover:underline">
                          {a.name}
                        </div>
                        <div className="text-[11px] text-fg-muted">
                          {a.number} · {a.email}
                        </div>
                      </button>
                    </td>
                    <td className="py-2 px-2 text-xs text-fg-muted">
                      {a.territory ?? "—"}
                    </td>
                    <td className="py-2 px-2 text-right text-xs">
                      {/*
                        "Product default" rather than a number when the
                        agent carries no override — printing the
                        product's rate here would imply this agent is
                        pinned to it, and they are not: it moves when
                        the product moves.
                      */}
                      {a.commissionRate === null ? (
                        <span className="text-fg-subtle">Product default</span>
                      ) : (
                        <span className="tabular">
                          {(a.commissionRate * 100).toFixed(2)}%
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-2 text-right tabular text-xs">
                      {a.totals.fundedCount}/{a.totals.loanCount}
                    </td>
                    <td className="py-2 px-2 text-right tabular text-success">
                      {formatMoney(a.totals.earned)}
                    </td>
                    {/*
                      Earned is a career total — paid AND unpaid. Owed is
                      this agent's slice of account 2500 right now, and
                      it is the only one of the two a cashier should be
                      reading. Kept in its own column rather than folded
                      in, because handing over "earned" would pay every
                      commission the agent has ever made all over again.
                    */}
                    <OwedCell agentId={a.id} />
                    <td className="py-2 px-2 text-right tabular text-xs text-fg-muted">
                      {formatMoney(a.totals.pipeline)}
                    </td>
                    <td className="py-2 px-2 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        {!a.active && <Badge variant="muted">Inactive</Badge>}
                        {canPayout && a.totals.earned > 0 && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setPaying(a)}
                          >
                            <Banknote className="mr-1 h-3.5 w-3.5" />
                            Pay
                          </Button>
                        )}
                        {canManage && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditing(a)}
                          >
                            Edit
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {creating && <CreateAgentDialog onClose={() => setCreating(false)} />}
      {editing && (
        <EditAgentDialog agent={editing} onClose={() => setEditing(null)} />
      )}
      {openBook && (
        <AgentBookDialog agent={openBook} onClose={() => setOpenBook(null)} />
      )}
      {paying && (
        <PayoutDialog agent={paying} onClose={() => setPaying(null)} />
      )}

      <PayoutHistory />
    </div>
  );
}

/**
 * One agent's outstanding balance, fetched per row.
 *
 * Deliberately a separate request rather than a field on the directory
 * payload: the payable figure has to be computed from the payout line
 * items, and loading those for every agent would make the list pay for
 * a number most rows are only glanced at.
 */
function OwedCell({ agentId }: { agentId: string }) {
  const payable = useAgentPayable(agentId);
  const owed = payable.data?.payableTotal;
  return (
    <td className="py-2 px-2 text-right tabular text-xs">
      {owed === undefined ? (
        <span className="text-fg-subtle">…</span>
      ) : owed > 0 ? (
        <span className="font-medium text-warning">{formatMoney(owed)}</span>
      ) : (
        <span className="text-fg-subtle">—</span>
      )}
    </td>
  );
}

// ─── register ────────────────────────────────────────────────────────

function CreateAgentDialog({ onClose }: { onClose: () => void }) {
  const users = useUsers();
  const agents = useAgents({ active: undefined, take: 200 });
  const create = useCreateAgent();
  const toast = useToast();

  const [userId, setUserId] = useState("");
  const [ratePct, setRatePct] = useState("");
  const [territory, setTerritory] = useState("");

  /*
   * Users already registered are filtered out of the picker rather than
   * offered and then rejected. One agent per login is a hard constraint,
   * so a name in this list that cannot be chosen is a trap.
   */
  const taken = new Set((agents.data ?? []).map((a) => a.userId));
  const available = (users.data ?? []).filter((u) => !taken.has(u.id));

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const agent = await create.mutateAsync({
        userId,
        // Blank means "inherit the product's rate". A typed 0 does not —
        // it means this agent earns nothing — so the two cannot collapse
        // into one another here either.
        commissionRate: ratePct.trim() === "" ? null : Number(ratePct) / 100,
        territory: territory.trim() || null,
      });
      toast.success(`${agent.number} registered.`);
      onClose();
    } catch (err) {
      toast.error((err as Error).message ?? "Could not register the agent");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Register an agent</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="ag-user">User account</Label>
            <Select value={userId} onValueChange={setUserId}>
              <SelectTrigger id="ag-user">
                <SelectValue placeholder="Pick a user" />
              </SelectTrigger>
              <SelectContent>
                {available.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name} — {u.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {available.length === 0 && !users.isLoading && (
              <p className="text-[11px] text-fg-subtle">
                Every user is already an agent. Create the user account first.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ag-rate">Commission rate (%)</Label>
            <Input
              id="ag-rate"
              type="number"
              step="0.01"
              min={0}
              max={50}
              placeholder="Leave blank to use the product's rate"
              value={ratePct}
              onChange={(e) => setRatePct(e.target.value)}
            />
            <p className="text-[11px] text-fg-subtle">
              Overrides the product default for every loan this agent brings in.
              Blank inherits; 0 means they earn nothing.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ag-territory">Territory</Label>
            <Input
              id="ag-territory"
              value={territory}
              onChange={(e) => setTerritory(e.target.value)}
              placeholder="Optional"
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending} disabled={!userId}>
              Register
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── edit ────────────────────────────────────────────────────────────

function EditAgentDialog({
  agent,
  onClose,
}: {
  agent: Agent;
  onClose: () => void;
}) {
  const update = useUpdateAgent();
  const toast = useToast();
  const [ratePct, setRatePct] = useState(
    agent.commissionRate === null ? "" : String(agent.commissionRate * 100),
  );
  const [territory, setTerritory] = useState(agent.territory ?? "");

  const save = async (patch: Parameters<typeof update.mutateAsync>[0]) => {
    try {
      await update.mutateAsync(patch);
      toast.success(`${agent.number} updated.`);
      onClose();
    } catch (err) {
      toast.error((err as Error).message ?? "Could not update the agent");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {agent.name} · {agent.number}
          </DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save({
              id: agent.id,
              commissionRate:
                ratePct.trim() === "" ? null : Number(ratePct) / 100,
              territory: territory.trim() || null,
            });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="ed-rate">Commission rate (%)</Label>
            <Input
              id="ed-rate"
              type="number"
              step="0.01"
              min={0}
              max={50}
              placeholder="Blank uses the product's rate"
              value={ratePct}
              onChange={(e) => setRatePct(e.target.value)}
            />
            <p className="text-[11px] text-fg-subtle">
              {/*
                The single most important thing this dialog can say. An
                officer who lowers a rate expecting past commissions to
                shrink — or raises one expecting a top-up — will be
                wrong, and finding that out from a payroll dispute is
                worse than reading it here.
              */}
              Applies to loans assigned from now on. Loans already assigned keep
              the rate they were given.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ed-territory">Territory</Label>
            <Input
              id="ed-territory"
              value={territory}
              onChange={(e) => setTerritory(e.target.value)}
            />
          </div>

          <div className="rounded-md border border-default bg-surface-1 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">
                  {agent.active ? "Active" : "Deactivated"}
                </div>
                <p className="text-[11px] text-fg-muted">
                  A deactivated agent takes no new applications but keeps every
                  loan and every peso already credited to them.
                </p>
              </div>
              <Button
                type="button"
                variant={agent.active ? "outline" : "default"}
                size="sm"
                onClick={() =>
                  void save({ id: agent.id, active: !agent.active })
                }
              >
                {agent.active ? "Deactivate" : "Reactivate"}
              </Button>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={update.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── one agent's book ────────────────────────────────────────────────

function AgentBookDialog({
  agent,
  onClose,
}: {
  agent: Agent;
  onClose: () => void;
}) {
  const book = useAgentBook(agent.id);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-3">
            <span>
              {agent.name} · {agent.number}
            </span>
            <Button variant="ghost" size="sm" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </DialogTitle>
        </DialogHeader>
        {book.isLoading ? (
          <SkeletonCard />
        ) : (
          <div className="space-y-4">
            <AgentStats totals={book.data!.totals} />
            <AgentBookTable loans={book.data!.loans} linkCustomers linkLoans />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
