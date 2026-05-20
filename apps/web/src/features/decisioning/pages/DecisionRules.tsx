import {
  useCreateDecisionRule,
  useDecisionRules,
  useDeleteDecisionRule,
  useSeedDecisionRules,
  useUpdateDecisionRule,
} from '@loan/api-client';
import type {
  DecisionRule,
  DecisioningCondition,
  DecisioningOp,
  RuleAction,
} from '@loan/shared-types';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SkeletonCard,
  useConfirm,
  useToast,
} from '@loan/ui';
import { Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { useAuth } from '../../../providers/auth';

const FIELDS = [
  'productCode',
  'principal',
  'termMonths',
  'annualInterestRate',
  'tierAtApply',
  'creditScoreAtApply',
  'amlStatus',
  'kycComplete',
  'customerAge',
  'monthlyIncome',
  'existingActiveLoans',
] as const;

const OPS: DecisioningOp[] = ['=', '!=', '<', '<=', '>', '>=', 'in', 'not_in'];

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
  const { user } = useAuth();
  const canEdit = user?.role === 'ADMIN';
  const [editing, setEditing] = useState<DecisionRule | null>(null);
  const [creating, setCreating] = useState(false);

  const onDelete = async (r: DecisionRule) => {
    const ok = await confirm({
      title: `Delete rule "${r.name}"?`,
      message:
        'New applications will no longer be evaluated against this rule. Existing decisions are unaffected.',
      confirmLabel: 'Delete rule',
      tone: 'destructive',
    });
    if (!ok) return;
    try {
      await remove.mutateAsync(r.id);
      toast.success('Rule deleted');
    } catch (err) {
      toast.error((err as Error).message ?? 'Failed');
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
                  toast.error((err as Error).message ?? 'Failed');
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
        <p className="text-xs text-white/55 mb-3">
          Rules evaluate at loan apply time in priority order (lowest first).
          The first rule whose conditions ALL match decides the loan's initial
          status. If nothing matches, the loan stays SUBMITTED for manual review.
        </p>
        {rules.isLoading ? (
          <SkeletonCard />
        ) : (rules.data ?? []).length === 0 ? (
          <p className="text-sm text-white/55">
            No rules configured. Every loan goes to manual review. Click "Seed defaults" for a starting policy.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-white/45">
              <tr>
                <th className="py-2 px-2 w-16">Priority</th>
                <th className="py-2 px-2">Name</th>
                <th className="py-2 px-2">Conditions</th>
                <th className="py-2 px-2">Action</th>
                <th className="py-2 px-2">Status</th>
                <th />
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {(rules.data ?? []).map((r) => (
                <tr key={r.id} className="hover:bg-white/[0.03] align-top">
                  <td className="py-2 px-2 font-mono">{r.priority}</td>
                  <td className="py-2 px-2">
                    <div className="font-medium">{r.name}</div>
                    {r.description && (
                      <div className="text-xs text-white/45">{r.description}</div>
                    )}
                  </td>
                  <td className="py-2 px-2 text-xs">
                    <ul className="space-y-0.5">
                      {(r.conditions ?? []).map((c, i) => (
                        <li key={i} className="font-mono">
                          {c.field} {c.op}{' '}
                          {Array.isArray(c.value) ? `[${c.value.join(',')}]` : String(c.value)}
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td className="py-2 px-2">
                    <ActionBadge action={r.action} />
                  </td>
                  <td className="py-2 px-2">
                    <Badge variant={r.active ? 'success' : 'muted'}>
                      {r.active ? 'Active' : 'Paused'}
                    </Badge>
                  </td>
                  <td className="py-2 px-2 text-right">
                    {canEdit && (
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => setEditing(r)}
                          className="text-white/55 hover:text-sky-300"
                          title="Edit"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onDelete(r)}
                          className="text-white/55 hover:text-rose-300"
                          title="Delete"
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
      {editing && <RuleDialog rule={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function ActionBadge({ action }: { action: RuleAction }) {
  const v =
    action === 'AUTO_APPROVE'
      ? 'success'
      : action === 'AUTO_REJECT'
        ? 'danger'
        : 'warning';
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
  const [name, setName] = useState(rule?.name ?? '');
  const [description, setDescription] = useState(rule?.description ?? '');
  const [priority, setPriority] = useState(rule?.priority ?? 500);
  const [action, setAction] = useState<RuleAction>(rule?.action ?? 'AUTO_APPROVE');
  const [reason, setReason] = useState(rule?.reason ?? '');
  const [active, setActive] = useState(rule?.active ?? true);
  const [conditions, setConditions] = useState<DecisioningCondition[]>(
    rule?.conditions ?? [{ field: 'tierAtApply', op: '=', value: 'A' }],
  );

  const setCondition = (idx: number, patch: Partial<DecisioningCondition>) => {
    setConditions(conditions.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      if (rule) {
        await update.mutateAsync({
          id: rule.id,
          name,
          description: description || undefined,
          priority,
          conditions,
          action,
          reason: reason || undefined,
          active,
        });
        toast.success('Rule saved');
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
        toast.success('Rule created');
      }
      onClose();
    } catch (err) {
      toast.error((err as Error).message ?? 'Failed');
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{rule ? 'Edit rule' : 'New rule'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} required />
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
              <Select value={action} onValueChange={(v) => setAction(v as RuleAction)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="AUTO_APPROVE">Auto-approve</SelectItem>
                  <SelectItem value="AUTO_REJECT">Auto-reject</SelectItem>
                  <SelectItem value="MANUAL_REVIEW">Manual review</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label="Status">
              <Select value={active ? 'a' : 'p'} onValueChange={(v) => setActive(v === 'a')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="a">Active</SelectItem>
                  <SelectItem value="p">Paused</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field label="Reason (stored on loan when this rule fires)">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>

          <div className="rounded-md border border-white/10 p-3 space-y-2">
            <div className="text-xs uppercase tracking-wider text-white/45 flex items-center justify-between">
              <span>Conditions (ALL must match)</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  setConditions([
                    ...conditions,
                    { field: 'principal', op: '<=', value: 100_000 },
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
                  <Select value={c.field} onValueChange={(v) => setCondition(i, { field: v })}>
                    <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {FIELDS.map((f) => (
                        <SelectItem key={f} value={f}>{f}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="col-span-2">
                  <Select value={c.op} onValueChange={(v) => setCondition(i, { op: v as DecisioningOp })}>
                    <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {OPS.map((o) => (
                        <SelectItem key={o} value={o}>{o}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Input
                  className="col-span-5 h-9"
                  value={Array.isArray(c.value) ? c.value.join(',') : String(c.value)}
                  onChange={(e) => {
                    const v = e.target.value;
                    let parsed: DecisioningCondition['value'] = v;
                    if (c.op === 'in' || c.op === 'not_in') {
                      parsed = v.split(',').map((s) => {
                        const n = Number(s.trim());
                        return Number.isFinite(n) && s.trim() !== '' ? n : s.trim();
                      });
                    } else if (v === 'true' || v === 'false') {
                      parsed = v === 'true';
                    } else if (Number.isFinite(Number(v))) {
                      parsed = Number(v);
                    }
                    setCondition(i, { value: parsed });
                  }}
                />
                <button
                  type="button"
                  className="col-span-1 text-white/55 hover:text-rose-300"
                  onClick={() => setConditions(conditions.filter((_, idx) => idx !== i))}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={create.isPending || update.isPending}>
              {rule ? 'Save' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-white/55">{label}</label>
      {children}
    </div>
  );
}
