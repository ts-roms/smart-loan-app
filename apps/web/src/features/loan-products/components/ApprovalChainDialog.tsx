import { useApprovalChain, useUpdateApprovalChain } from "@loan/api-client";
import type { LoanApprovalStepInput } from "@loan/shared-types";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  SkeletonCard,
  useToast,
} from "@loan/ui";
import { ArrowDown, ArrowUp, ListChecks, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * Per-product approval-chain editor.
 *
 * Each row is one step:
 *   - human label (free text)
 *   - required permission key (dropdown from a curated list; advanced
 *     users can type anything if they have a custom permission)
 *   - reorder / delete controls
 *
 * Saving replaces the entire chain via the PUT endpoint — the server
 * normalises orders to 1..N so reorder semantics are simple. An empty
 * chain (zero rows + Save) clears the chain, which restores the legacy
 * single-decide flow for new loans of this product.
 */

// Keys offered as a quick-pick. Callers can still type a custom key,
// useful for orgs that define their own permission graph.
const SUGGESTED_PERMISSIONS: Array<{ key: string; label: string }> = [
  { key: "loans.approve.officer", label: "Officer step" },
  { key: "loans.approve.bm", label: "Branch Manager step" },
  { key: "loans.approve.committee", label: "Credit Committee step" },
];

interface DraftStep {
  /** Local UI key — not persisted; the server assigns order from position. */
  key: string;
  label: string;
  requiredPermission: string;
}

let nextDraftKey = 0;
const makeKey = () => `draft-${++nextDraftKey}`;

export function ApprovalChainDialog({
  productCode,
  productName,
  onClose,
}: {
  productCode: string;
  productName: string;
  onClose: () => void;
}) {
  const chain = useApprovalChain(productCode);
  const update = useUpdateApprovalChain(productCode);
  const toast = useToast();
  const [steps, setSteps] = useState<DraftStep[]>([]);

  // Hydrate from the server response when it arrives.
  useEffect(() => {
    if (!chain.data) return;
    setSteps(
      chain.data.map((s) => ({
        key: makeKey(),
        label: s.label,
        requiredPermission: s.requiredPermission,
      })),
    );
  }, [chain.data]);

  const add = () => {
    setSteps((curr) => [
      ...curr,
      {
        key: makeKey(),
        label: "",
        requiredPermission: SUGGESTED_PERMISSIONS[0]!.key,
      },
    ]);
  };

  const remove = (key: string) => {
    setSteps((curr) => curr.filter((s) => s.key !== key));
  };

  const move = (key: string, delta: -1 | 1) => {
    setSteps((curr) => {
      const idx = curr.findIndex((s) => s.key === key);
      if (idx < 0) return curr;
      const next = idx + delta;
      if (next < 0 || next >= curr.length) return curr;
      const copy = [...curr];
      const [picked] = copy.splice(idx, 1);
      copy.splice(next, 0, picked!);
      return copy;
    });
  };

  const update_ = (key: string, patch: Partial<DraftStep>) => {
    setSteps((curr) =>
      curr.map((s) => (s.key === key ? { ...s, ...patch } : s)),
    );
  };

  const save = async () => {
    // Validate: labels + permission keys must be non-empty.
    for (const [i, s] of steps.entries()) {
      if (!s.label.trim()) {
        toast.error(`Step ${i + 1} needs a label.`);
        return;
      }
      if (!s.requiredPermission.trim()) {
        toast.error(`Step ${i + 1} needs a required permission key.`);
        return;
      }
    }
    const payload: LoanApprovalStepInput[] = steps.map((s, i) => ({
      order: i + 1,
      label: s.label.trim(),
      requiredPermission: s.requiredPermission.trim(),
    }));
    try {
      await update.mutateAsync(payload);
      toast.success(
        payload.length === 0
          ? "Approval chain cleared. New loans use the legacy single-decide flow."
          : `Approval chain saved (${payload.length} steps).`,
      );
      onClose();
    } catch (err) {
      toast.error((err as Error).message ?? "Save failed.");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ListChecks className="h-4 w-4 text-primary" />
            Approval chain — {productName}
          </DialogTitle>
          <DialogDescription>
            Sequential steps for new loans of this product. Each step needs a
            permission key; anyone who holds the key (or has it via active
            delegation) can approve. Save with zero steps to revert to the
            legacy single-decide flow.
          </DialogDescription>
        </DialogHeader>

        {chain.isLoading ? (
          <SkeletonCard />
        ) : (
          <div className="space-y-2">
            {steps.length === 0 && (
              <div className="rounded-md border border-dashed border-default bg-surface-2 p-4 text-center text-sm text-fg-muted">
                No steps yet. New loans for this product use the legacy
                single-decide flow. Add a step to switch to chain-based
                approval.
              </div>
            )}
            {steps.map((s, i) => (
              <div
                key={s.key}
                className="rounded-md border border-default bg-surface-2 p-3 flex items-start gap-2"
              >
                <div className="text-[10px] font-mono text-fg-subtle uppercase tracking-wider mt-2 shrink-0 w-8">
                  Step {i + 1}
                </div>
                <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <Label>Label</Label>
                    <Input
                      value={s.label}
                      onChange={(e) =>
                        update_(s.key, { label: e.target.value })
                      }
                      placeholder="e.g. Branch Manager review"
                    />
                  </div>
                  <div>
                    <Label>Required permission</Label>
                    <div className="space-y-1">
                      <select
                        value={
                          SUGGESTED_PERMISSIONS.some(
                            (p) => p.key === s.requiredPermission,
                          )
                            ? s.requiredPermission
                            : "custom"
                        }
                        onChange={(e) => {
                          if (e.target.value === "custom") return;
                          update_(s.key, {
                            requiredPermission: e.target.value,
                          });
                        }}
                        className="w-full rounded-md border border-default bg-surface-2 px-2 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {SUGGESTED_PERMISSIONS.map((p) => (
                          <option key={p.key} value={p.key}>
                            {p.label} ({p.key})
                          </option>
                        ))}
                        <option value="custom">Custom…</option>
                      </select>
                      {/* Always-visible raw input so callers can override
                          with any permission key their org uses. */}
                      <Input
                        value={s.requiredPermission}
                        onChange={(e) =>
                          update_(s.key, { requiredPermission: e.target.value })
                        }
                        className="font-mono text-xs"
                        placeholder="permission.key"
                      />
                    </div>
                  </div>
                </div>
                <div className="flex flex-col gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => move(s.key, -1)}
                    disabled={i === 0}
                    className="rounded-md p-1.5 text-fg-subtle hover:text-fg hover:bg-surface-3 disabled:opacity-30 disabled:hover:bg-transparent"
                    title="Move up"
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(s.key, 1)}
                    disabled={i === steps.length - 1}
                    className="rounded-md p-1.5 text-fg-subtle hover:text-fg hover:bg-surface-3 disabled:opacity-30 disabled:hover:bg-transparent"
                    title="Move down"
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(s.key)}
                    className="rounded-md p-1.5 text-fg-subtle hover:text-danger hover:bg-danger-soft"
                    title="Remove step"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}

            <Button variant="outline" onClick={add} className="w-full">
              <Plus className="h-4 w-4" />
              Add step
            </Button>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={update.isPending}>
            {update.isPending ? "Saving…" : "Save chain"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
