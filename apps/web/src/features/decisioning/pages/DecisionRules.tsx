import {
  useCreateDecisionRule,
  useDecisionRuleHistory,
  useDecisionRules,
  useDeleteDecisionRule,
  useSeedDecisionRules,
  useUpdateDecisionRule,
} from "@loan/api-client";
import type {
  DecisionRule,
  DecisionRuleVersion,
  DecisioningCondition,
  DecisioningOp,
  RuleAction,
} from "@loan/shared-types";
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
  Field,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SkeletonCard,
  useConfirm,
  useToast,
} from "@loan/ui";
import { History, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";

import { usePermission } from "../../../hooks/use-permission";

const FIELDS = [
  "productCode",
  "principal",
  "termMonths",
  "annualInterestRate",
  "tierAtApply",
  "creditScoreAtApply",
  "amlStatus",
  "kycComplete",
  "customerAge",
  "monthlyIncome",
  "existingActiveLoans",
] as const;

const OPS: DecisioningOp[] = ["=", "!=", "<", "<=", ">", ">=", "in", "not_in"];

/**
 * Admin-only catalog of decision rules. Each rule has a priority, an
 * AND-list of conditions, and an action (auto-approve / auto-reject /
 * manual review). At apply time, rules are evaluated in priority order
 * and the first match decides the loan's status.
 *
 * The DSL is intentionally simple — no AND/OR nesting. If you need OR,
 * write two rules with the same action but different conditions.
 */
export function DecisionRulesPage() {
  const rules = useDecisionRules();
  const seed = useSeedDecisionRules();
  const remove = useDeleteDecisionRule();
  const toast = useToast();
  const confirm = useConfirm();
  const canEdit = usePermission("admin.decision_rules");
  const [editing, setEditing] = useState<DecisionRule | null>(null);
  const [creating, setCreating] = useState(false);
  const [historyFor, setHistoryFor] = useState<DecisionRule | null>(null);

  const onRetire = async (r: DecisionRule) => {
    const ok = await confirm({
      title: `Retire rule "${r.name}"?`,
      message:
        "New applications will no longer be evaluated against this rule. " +
        "Decisions already made are unaffected, and this rule's history stays " +
        "on file so they remain explainable.",
      confirmLabel: "Retire rule",
      tone: "destructive",
    });
    if (!ok) return;
    try {
      await remove.mutateAsync(r.id);
      toast.success("Rule retired");
    } catch (err) {
      toast.error((err as Error).message ?? "Failed");
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Decision rules</CardTitle>
        {canEdit && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={async () => {
                try {
                  const r = await seed.mutateAsync();
                  toast.success(`Seeded ${r.created} (${r.existing} present)`);
                } catch (err) {
                  toast.error((err as Error).message ?? "Failed");
                }
              }}
              disabled={seed.isPending}
            >
              <Sparkles className="h-4 w-4" />
              Seed defaults
            </Button>
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" />
              New rule
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent>
        <p className="text-xs text-fg-muted mb-3">
          Rules evaluate at loan apply time in priority order (lowest first).
          The first rule whose conditions ALL match decides the loan's initial
          status. If nothing matches, the loan stays SUBMITTED for manual
          review.
        </p>
        {rules.isLoading ? (
          <SkeletonCard />
        ) : (rules.data ?? []).length === 0 ? (
          <p className="text-sm text-fg-muted">
            No rules configured. Every loan goes to manual review. Click "Seed
            defaults" for a starting policy.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
              <tr>
                <th className="py-2 px-2 w-16">Priority</th>
                <th className="py-2 px-2">Name</th>
                <th className="py-2 px-2">Conditions</th>
                <th className="py-2 px-2">Action</th>
                <th className="py-2 px-2">Status</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-default">
              {(rules.data ?? []).map((r) => (
                <tr key={r.id} className="hover:bg-hover align-top">
                  <td className="py-2 px-2 font-mono">{r.priority}</td>
                  <td className="py-2 px-2">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium">{r.name}</span>
                      {/*
                        Shown for every rule, including v1. A version
                        number only present on edited rules would read as
                        a warning badge; present on all of them it reads
                        as what it is — which revision this is.
                      */}
                      <button
                        type="button"
                        onClick={() => setHistoryFor(r)}
                        title="View change history"
                        /*
                          The visible label is "v3", which as an
                          accessible name tells a screen-reader user
                          nothing — `title` does not win against text
                          content. Named explicitly so the control
                          announces what it does.
                        */
                        aria-label={`View change history for ${r.name} (currently v${r.version})`}
                        className="rounded px-1 font-mono text-[10px] text-fg-subtle hover:bg-hover hover:text-info"
                      >
                        v{r.version}
                      </button>
                    </div>
                    {r.description && (
                      <div className="text-xs text-fg-subtle">
                        {r.description}
                      </div>
                    )}
                  </td>
                  <td className="py-2 px-2 text-xs">
                    <ul className="space-y-0.5">
                      {(r.conditions ?? []).map((c, i) => (
                        <li key={i} className="font-mono">
                          {c.field} {c.op}{" "}
                          {Array.isArray(c.value)
                            ? `[${c.value.join(",")}]`
                            : String(c.value)}
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td className="py-2 px-2">
                    <ActionBadge action={r.action} />
                  </td>
                  <td className="py-2 px-2">
                    <Badge variant={r.active ? "success" : "muted"}>
                      {r.active ? "Active" : "Paused"}
                    </Badge>
                  </td>
                  <td className="py-2 px-2 text-right">
                    {canEdit && (
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => setEditing(r)}
                          className="text-fg-muted hover:text-info"
                          title="Edit"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setHistoryFor(r)}
                          className="text-fg-muted hover:text-info"
                          title="History"
                        >
                          <History className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onRetire(r)}
                          className="text-fg-muted hover:text-danger"
                          title="Retire"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
      {creating && <RuleDialog onClose={() => setCreating(false)} />}
      {editing && (
        <RuleDialog rule={editing} onClose={() => setEditing(null)} />
      )}
      {historyFor && (
        <HistoryDialog rule={historyFor} onClose={() => setHistoryFor(null)} />
      )}
    </Card>
  );
}

function ActionBadge({ action }: { action: RuleAction }) {
  const v =
    action === "AUTO_APPROVE"
      ? "success"
      : action === "AUTO_REJECT"
        ? "danger"
        : "warning";
  return <Badge variant={v}>{action}</Badge>;
}

function RuleDialog({
  rule,
  onClose,
}: {
  rule?: DecisionRule;
  onClose: () => void;
}) {
  const create = useCreateDecisionRule();
  const update = useUpdateDecisionRule();
  const toast = useToast();
  const [name, setName] = useState(rule?.name ?? "");
  const [description, setDescription] = useState(rule?.description ?? "");
  const [priority, setPriority] = useState(rule?.priority ?? 500);
  const [action, setAction] = useState<RuleAction>(
    rule?.action ?? "AUTO_APPROVE",
  );
  const [reason, setReason] = useState(rule?.reason ?? "");
  const [active, setActive] = useState(rule?.active ?? true);
  const [conditions, setConditions] = useState<DecisioningCondition[]>(
    rule?.conditions ?? [{ field: "tierAtApply", op: "=", value: "A" }],
  );
  const [changeNote, setChangeNote] = useState("");

  const setCondition = (idx: number, patch: Partial<DecisioningCondition>) => {
    setConditions(
      conditions.map((c, i) => (i === idx ? { ...c, ...patch } : c)),
    );
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      if (rule) {
        await update.mutateAsync({
          id: rule.id,
          changeNote: changeNote || undefined,
          name,
          description: description || undefined,
          priority,
          conditions,
          action,
          reason: reason || undefined,
          active,
        });
        toast.success("Rule saved");
      } else {
        await create.mutateAsync({
          name,
          description: description || undefined,
          priority,
          conditions,
          action,
          reason: reason || undefined,
          active,
        });
        toast.success("Rule created");
      }
      onClose();
    } catch (err) {
      toast.error((err as Error).message ?? "Failed");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{rule ? "Edit rule" : "New rule"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </Field>
            <Field label="Priority (lower fires first)">
              <Input
                type="number"
                min={0}
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
              />
            </Field>
          </div>
          <Field label="Description (optional)">
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Action">
              {(id) => (
                <Select
                  value={action}
                  onValueChange={(v) => setAction(v as RuleAction)}
                >
                  <SelectTrigger id={id}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="AUTO_APPROVE">Auto-approve</SelectItem>
                    <SelectItem value="AUTO_REJECT">Auto-reject</SelectItem>
                    <SelectItem value="MANUAL_REVIEW">Manual review</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </Field>
            <Field label="Status">
              {(id) => (
                <Select
                  value={active ? "a" : "p"}
                  onValueChange={(v) => setActive(v === "a")}
                >
                  <SelectTrigger id={id}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="a">Active</SelectItem>
                    <SelectItem value="p">Paused</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </Field>
          </div>
          <Field label="Reason (stored on loan when this rule fires)">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>

          {/*
            Only on edit. On create the change note would just restate
            "created", which the version row already says.
          */}
          {rule && (
            <Field label="What changed, and why (optional — kept in history)">
              <Input
                value={changeNote}
                onChange={(e) => setChangeNote(e.target.value)}
                placeholder="e.g. Raised the B-tier ceiling after Q2 delinquency review"
              />
            </Field>
          )}

          <div className="rounded-md border border-default p-3 space-y-2">
            <div className="text-xs uppercase tracking-wider text-fg-subtle flex items-center justify-between">
              <span>Conditions (ALL must match)</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  setConditions([
                    ...conditions,
                    { field: "principal", op: "<=", value: 100_000 },
                  ])
                }
              >
                <Plus className="h-3 w-3" />
                Add
              </Button>
            </div>
            {conditions.map((c, i) => (
              <div key={i} className="grid grid-cols-12 gap-2 text-xs">
                <div className="col-span-4">
                  <Select
                    value={c.field}
                    onValueChange={(v) => setCondition(i, { field: v })}
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FIELDS.map((f) => (
                        <SelectItem key={f} value={f}>
                          {f}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="col-span-2">
                  <Select
                    value={c.op}
                    onValueChange={(v) =>
                      setCondition(i, { op: v as DecisioningOp })
                    }
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {OPS.map((o) => (
                        <SelectItem key={o} value={o}>
                          {o}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Input
                  className="col-span-5 h-9"
                  value={
                    Array.isArray(c.value) ? c.value.join(",") : String(c.value)
                  }
                  onChange={(e) => {
                    const v = e.target.value;
                    let parsed: DecisioningCondition["value"] = v;
                    if (c.op === "in" || c.op === "not_in") {
                      parsed = v.split(",").map((s) => {
                        const n = Number(s.trim());
                        return Number.isFinite(n) && s.trim() !== ""
                          ? n
                          : s.trim();
                      });
                    } else if (v === "true" || v === "false") {
                      parsed = v === "true";
                    } else if (Number.isFinite(Number(v))) {
                      parsed = Number(v);
                    }
                    setCondition(i, { value: parsed });
                  }}
                />
                <button
                  type="button"
                  className="col-span-1 text-fg-muted hover:text-danger"
                  onClick={() =>
                    setConditions(conditions.filter((_, idx) => idx !== i))
                  }
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={create.isPending || update.isPending}
            >
              {rule ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Every revision of one rule, newest first.
 *
 * The question this page previously could not answer: a loan approved
 * in March was approved under the rule AS IT READ IN MARCH, and until
 * now the only copy of a rule was the current one. Reading today's
 * threshold to explain last quarter's approval is not an audit trail —
 * it is a guess that looks like one.
 *
 * Rendered as a list rather than a diff on purpose: what an auditor
 * needs is what the rule REQUIRED in a period, and a diff shows the
 * change while hiding the state.
 */
function HistoryDialog({
  rule,
  onClose,
}: {
  rule: DecisionRule;
  onClose: () => void;
}) {
  const history = useDecisionRuleHistory(rule.id);
  const versions = history.data ?? [];

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>History — {rule.name}</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-fg-muted">
          Each entry is the rule as it stood for that period. Loans decided
          inside a period were decided by that text of the rule.
        </p>
        {history.isLoading ? (
          <SkeletonCard />
        ) : versions.length === 0 ? (
          <p className="text-sm text-fg-muted">No history recorded.</p>
        ) : (
          <ol className="max-h-[26rem] space-y-2 overflow-y-auto">
            {versions.map((v) => (
              <VersionEntry key={v.id} version={v} />
            ))}
          </ol>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VersionEntry({ version: v }: { version: DecisionRuleVersion }) {
  /*
   * A RETIRE row has effectiveTo === effectiveFrom — a zero-width
   * window, because that text of the rule was never in force. Labelling
   * it as a period would invite someone to read it as one.
   */
  const retired = v.changeType === "RETIRE";
  const current = v.effectiveTo === null;

  return (
    <li className="rounded-md border border-default p-3 text-xs">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="font-mono text-fg-subtle">v{v.version}</span>
        <span className="font-medium">{v.ruleName}</span>
        <ActionBadge action={v.action} />
        <Badge variant={v.active ? "success" : "muted"}>
          {v.active ? "Active" : "Paused"}
        </Badge>
        {current && <Badge variant="info">Current</Badge>}
        {retired && <Badge variant="muted">Retired</Badge>}
      </div>
      <div className="mb-1.5 text-fg-subtle">
        {retired ? (
          <>Withdrawn {fmt(v.effectiveFrom)}</>
        ) : (
          <>
            In force {fmt(v.effectiveFrom)} —{" "}
            {v.effectiveTo ? fmt(v.effectiveTo) : "now"}
          </>
        )}
        <span className="mx-1.5">·</span>
        priority {v.priority}
      </div>
      <ul className="space-y-0.5 font-mono text-fg-muted">
        {(v.conditions ?? []).map((c, i) => (
          <li key={i}>
            {c.field} {c.op}{" "}
            {Array.isArray(c.value)
              ? `[${c.value.join(",")}]`
              : String(c.value)}
          </li>
        ))}
      </ul>
      {v.changeNote && (
        <p className="mt-1.5 italic text-fg-subtle">{v.changeNote}</p>
      )}
    </li>
  );
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
