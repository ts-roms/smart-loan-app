import {
  useAccounts,
  useJournalEntries,
  usePostJournalEntry,
  useReverseEntriesBulk,
  useReverseEntry,
} from "@loan/api-client";
import type { JournalSource } from "@loan/shared-types";
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
  DatePicker,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SkeletonCard,
  useConfirm,
  usePrompt,
  useToast,
} from "@loan/ui";
import { formatDate, formatMoney, todayLocalISO } from "@loan/shared-utils";
import { Plus, RotateCcw, Trash2 } from "lucide-react";

import { JournalEntryLink } from "../components/JournalEntryDrawer";
import { useState, type FormEvent } from "react";

import { useAuth } from "../../../providers/auth";

interface LineDraft {
  accountCode: string;
  debit: number;
  credit: number;
  memo: string;
}

/**
 * Journal entry list + manual-entry dialog. Auto-posted entries
 * (loan disbursements and payments) live here too — the `source` chip
 * makes them obvious.
 */
export function JournalEntriesPage() {
  const entries = useJournalEntries();
  const reverseOne = useReverseEntry();
  const reverseBulk = useReverseEntriesBulk();
  const toast = useToast();
  const confirm = useConfirm();
  const askPrompt = usePrompt();
  const { user } = useAuth();
  const canPost = user?.role === "ADMIN" || user?.role === "ACCOUNTANT";
  const [posting, setPosting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const data = entries.data ?? [];
  // Reversible = not already reversed, not itself a reversal, not auto-reversed-from.
  const reversible = (e: {
    reversedById?: string | null;
    source: JournalSource;
  }) => !e.reversedById && e.source !== "REVERSAL";

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const toggleAll = () => {
    if (selected.size === data.filter(reversible).length)
      setSelected(new Set());
    else setSelected(new Set(data.filter(reversible).map((e) => e.id)));
  };

  const onReverseOne = async (id: string) => {
    const memo = await askPrompt({
      title: "Reverse journal entry?",
      message:
        "A reversing entry will be posted into the current period. Optional: include a memo for the audit trail.",
      label: "Memo (optional)",
      placeholder: "e.g. correcting wrong account",
      confirmLabel: "Reverse",
    });
    if (memo === null) return;
    try {
      await reverseOne.mutateAsync({ id, memo: memo || undefined });
      toast.success("Entry reversed");
    } catch (err) {
      toast.error((err as Error).message ?? "Reversal failed");
    }
  };

  const onReverseSelected = async () => {
    if (selected.size === 0) return;
    const ok = await confirm({
      title: `Reverse ${selected.size} entr${selected.size === 1 ? "y" : "ies"}?`,
      message:
        "A reversing entry is posted into the current period for each. The originals stay in their original period and are marked reversed.",
      confirmLabel: "Reverse all",
      tone: "destructive",
    });
    if (!ok) return;
    const memo = await askPrompt({
      title: "Reason for bulk reversal?",
      message: "Optional memo applied to every reversing entry.",
      label: "Memo (optional)",
      placeholder: "e.g. quarterly close adjustment",
      confirmLabel: "Reverse",
    });
    if (memo === null) return;
    try {
      const r = await reverseBulk.mutateAsync({
        entryIds: [...selected],
        memo: memo || undefined,
      });
      toast.success(`${r.succeeded} reversed, ${r.failed} failed`);
      setSelected(new Set());
    } catch (err) {
      toast.error((err as Error).message ?? "Bulk reversal failed");
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Journal entries</CardTitle>
        <div className="flex items-center gap-2">
          {canPost && selected.size > 0 && (
            <Button
              variant="outline"
              onClick={onReverseSelected}
              disabled={reverseBulk.isPending}
            >
              <RotateCcw className="h-4 w-4" />
              {reverseBulk.isPending
                ? "Reversing…"
                : `Reverse ${selected.size} selected`}
            </Button>
          )}
          {canPost && (
            <Button onClick={() => setPosting(true)}>
              <Plus className="h-4 w-4" />
              New entry
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {entries.isLoading ? (
          <SkeletonCard />
        ) : data.length === 0 ? (
          <p className="text-sm text-fg-muted">No entries yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
              <tr>
                {canPost && (
                  <th className="py-2 px-2 w-8">
                    <input
                      type="checkbox"
                      checked={
                        selected.size > 0 &&
                        selected.size === data.filter(reversible).length
                      }
                      onChange={toggleAll}
                    />
                  </th>
                )}
                <th className="py-2 px-2">Number</th>
                <th className="py-2 px-2">Date</th>
                <th className="py-2 px-2">Source</th>
                <th className="py-2 px-2">Memo</th>
                <th className="py-2 px-2 text-right">Amount</th>
                <th className="py-2 px-2 w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-default">
              {data.map((e) => {
                const debits = (e.lines ?? []).reduce(
                  (s, l) => s + Number(l.debit),
                  0,
                );
                const isReversed = Boolean(e.reversedById);
                const isReversal = e.source === "REVERSAL";
                const canReverse = reversible(e);
                return (
                  <tr
                    key={e.id}
                    className={`hover:bg-hover align-top ${isReversed ? "opacity-50" : ""}`}
                  >
                    {canPost && (
                      <td className="py-2 px-2">
                        {canReverse ? (
                          <input
                            type="checkbox"
                            checked={selected.has(e.id)}
                            onChange={() => toggle(e.id)}
                          />
                        ) : null}
                      </td>
                    )}
                    <td className="py-2 px-2 font-mono">
                      <JournalEntryLink id={e.id}>
                        <span className="text-info hover:underline">
                          {e.number}
                        </span>
                      </JournalEntryLink>
                    </td>
                    <td className="py-2 px-2 text-fg-muted">
                      {formatDate(e.entryDate)}
                    </td>
                    <td className="py-2 px-2">
                      <SourceBadge source={e.source} />
                    </td>
                    <td className="py-2 px-2 max-w-[24ch]">
                      <div className="truncate" title={e.memo ?? ""}>
                        {e.memo ?? "—"}
                        {isReversed && (
                          <span className="ml-2 text-danger text-xs">
                            reversed
                          </span>
                        )}
                        {isReversal && (
                          <span className="ml-2 text-warning text-xs">
                            reversal entry
                          </span>
                        )}
                      </div>
                      {e.lines && (
                        <details className="mt-1 text-xs text-fg-muted">
                          <summary className="cursor-pointer">
                            {e.lines.length} lines
                          </summary>
                          <ul className="mt-1 space-y-0.5">
                            {e.lines.map((l) => (
                              <li key={l.id} className="font-mono">
                                {l.account?.code} {l.account?.name}
                                {" · "}
                                {Number(l.debit) > 0
                                  ? `Dr ${formatMoney(Number(l.debit))}`
                                  : `Cr ${formatMoney(Number(l.credit))}`}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </td>
                    <td className="py-2 px-2 text-right font-mono">
                      {formatMoney(debits)}
                    </td>
                    <td className="py-2 px-2 text-right">
                      {canPost && canReverse && (
                        <button
                          type="button"
                          title="Reverse this entry"
                          onClick={() => onReverseOne(e.id)}
                          className="text-fg-muted hover:text-danger"
                          disabled={reverseOne.isPending}
                        >
                          <RotateCcw className="h-3 w-3" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </CardContent>
      {posting && <NewEntryDialog onClose={() => setPosting(false)} />}
    </Card>
  );
}

function SourceBadge({ source }: { source: JournalSource }) {
  const map: Record<
    JournalSource,
    { label: string; variant: "success" | "danger" | "muted" | "warning" }
  > = {
    MANUAL: { label: "Manual", variant: "muted" },
    LOAN_DISBURSEMENT: { label: "Disbursement", variant: "success" },
    LOAN_PAYMENT: { label: "Payment", variant: "success" },
    REVERSAL: { label: "Reversal", variant: "warning" },
    ADJUSTMENT: { label: "Adjustment", variant: "warning" },
  };
  const v = map[source];
  return <Badge variant={v.variant}>{v.label}</Badge>;
}

function NewEntryDialog({ onClose }: { onClose: () => void }) {
  const accounts = useAccounts();
  const post = usePostJournalEntry();
  const toast = useToast();
  const [entryDate, setEntryDate] = useState(() => todayLocalISO());
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([
    { accountCode: "", debit: 0, credit: 0, memo: "" },
    { accountCode: "", debit: 0, credit: 0, memo: "" },
  ]);

  const totals = lines.reduce(
    (acc, l) => ({
      debit: acc.debit + (Number(l.debit) || 0),
      credit: acc.credit + (Number(l.credit) || 0),
    }),
    { debit: 0, credit: 0 },
  );
  const balanced =
    Math.abs(totals.debit - totals.credit) < 0.005 && totals.debit > 0;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!balanced) {
      toast.error("Debits must equal credits");
      return;
    }
    try {
      await post.mutateAsync({
        entryDate,
        memo: memo || undefined,
        lines: lines
          .filter((l) => l.accountCode && (l.debit > 0 || l.credit > 0))
          .map((l) => ({
            accountCode: l.accountCode,
            debit: Number(l.debit) || 0,
            credit: Number(l.credit) || 0,
            memo: l.memo || undefined,
          })),
      });
      toast.success("Journal entry posted");
      onClose();
    } catch (err) {
      toast.error((err as Error).message ?? "Could not post entry");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New journal entry</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Entry date">
              <DatePicker value={entryDate} onChange={setEntryDate} />
            </Field>
            <Field label="Memo">
              <Input value={memo} onChange={(e) => setMemo(e.target.value)} />
            </Field>
          </div>

          <div className="rounded-md border border-default">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
                <tr>
                  <th className="py-2 px-2">Account</th>
                  <th className="py-2 px-2 w-32">Debit</th>
                  <th className="py-2 px-2 w-32">Credit</th>
                  <th className="py-2 px-2">Memo</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {lines.map((l, idx) => (
                  <tr key={idx} className="border-t border-default">
                    <td className="p-1">
                      <Select
                        value={l.accountCode}
                        onValueChange={(v) =>
                          updateLine(setLines, idx, { accountCode: v })
                        }
                      >
                        <SelectTrigger className="h-9">
                          <SelectValue placeholder="— select account —" />
                        </SelectTrigger>
                        <SelectContent>
                          {(accounts.data ?? []).map((a) => (
                            <SelectItem key={a.id} value={a.code}>
                              {a.code} {a.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="p-1">
                      <Input
                        type="number"
                        min={0}
                        step={0.01}
                        value={l.debit || ""}
                        onChange={(e) =>
                          updateLine(setLines, idx, {
                            debit: Number(e.target.value),
                            credit: Number(e.target.value) > 0 ? 0 : l.credit,
                          })
                        }
                      />
                    </td>
                    <td className="p-1">
                      <Input
                        type="number"
                        min={0}
                        step={0.01}
                        value={l.credit || ""}
                        onChange={(e) =>
                          updateLine(setLines, idx, {
                            credit: Number(e.target.value),
                            debit: Number(e.target.value) > 0 ? 0 : l.debit,
                          })
                        }
                      />
                    </td>
                    <td className="p-1">
                      <Input
                        value={l.memo}
                        onChange={(e) =>
                          updateLine(setLines, idx, { memo: e.target.value })
                        }
                      />
                    </td>
                    <td className="p-1 text-right">
                      {lines.length > 2 && (
                        <button
                          type="button"
                          className="text-fg-subtle hover:text-danger"
                          onClick={() =>
                            setLines(lines.filter((_, i) => i !== idx))
                          }
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-default bg-surface-2">
                  <td className="px-2 py-2 text-xs uppercase tracking-wider text-fg-subtle">
                    Total
                  </td>
                  <td className="px-2 py-2 font-mono">
                    {formatMoney(totals.debit)}
                  </td>
                  <td className="px-2 py-2 font-mono">
                    {formatMoney(totals.credit)}
                  </td>
                  <td className="px-2 py-2 text-xs">
                    {balanced ? (
                      <span className="text-success">Balanced</span>
                    ) : (
                      <span className="text-danger">Out of balance</span>
                    )}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="flex justify-between">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setLines([
                  ...lines,
                  { accountCode: "", debit: 0, credit: 0, memo: "" },
                ])
              }
            >
              <Plus className="h-4 w-4" />
              Add line
            </Button>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={post.isPending} disabled={!balanced}>
              Post entry
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function updateLine(
  setLines: React.Dispatch<React.SetStateAction<LineDraft[]>>,
  idx: number,
  patch: Partial<LineDraft>,
) {
  setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs text-fg-muted">{label}</label>
      {children}
    </div>
  );
}
