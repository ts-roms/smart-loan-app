import { useJournalEntry, useReverseEntry } from "@loan/api-client";
import {
  Badge,
  Button,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
  SkeletonLine,
  useConfirm,
  usePrompt,
  useToast,
} from "@loan/ui";
import { formatDateTime, formatMoney } from "@loan/shared-utils";
import { ArrowUpRight, RotateCcw, ScrollText } from "lucide-react";
import { useState, type ReactNode } from "react";

/**
 * Click-to-inspect wrapper for any journal entry id. Wraps a child trigger
 * (typically a badge, button, or the entry number itself); clicking opens
 * a right-side drawer showing the entry's lines, source, and a reverse
 * button.
 *
 * Why a drawer instead of a navigation? Journal IDs appear across many
 * pages (ECL runs, contributions, savings, reconciliation matches, loan
 * postings). A drawer lets the user inspect without losing list context.
 *
 * Usage:
 *   <JournalEntryLink id={entry.id}>
 *     <Badge variant="success">Posted</Badge>
 *   </JournalEntryLink>
 */
export function JournalEntryLink({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <button
          type="button"
          className="text-left hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
          aria-label="Inspect journal entry"
        >
          {children}
        </button>
      </DrawerTrigger>
      <DrawerContent>
        <JournalEntryInspector id={id} onClose={() => setOpen(false)} />
      </DrawerContent>
    </Drawer>
  );
}

function JournalEntryInspector({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const entry = useJournalEntry(id);
  const reverse = useReverseEntry();
  const toast = useToast();
  const confirm = useConfirm();
  const askPrompt = usePrompt();

  const onReverse = async () => {
    const ok = await confirm({
      title: "Reverse this entry?",
      message:
        "A reversing entry is posted into the current period. The original stays in its original period and is marked reversed.",
      confirmLabel: "Reverse",
      tone: "destructive",
    });
    if (!ok) return;
    const memo = await askPrompt({
      title: "Memo (optional)",
      message: "Stamped onto the reversing entry for the audit trail.",
      label: "Memo",
      placeholder: "e.g. correcting wrong account",
      confirmLabel: "Reverse",
    });
    if (memo === null) return;
    try {
      await reverse.mutateAsync({ id, memo: memo || undefined });
      toast.success("Entry reversed");
      onClose();
    } catch (err) {
      toast.error((err as Error).message ?? "Reversal failed");
    }
  };

  if (entry.isLoading) {
    return (
      <>
        <DrawerHeader>
          <DrawerTitle>Journal entry</DrawerTitle>
        </DrawerHeader>
        <DrawerBody>
          <SkeletonLine />
          <SkeletonLine />
          <SkeletonLine />
        </DrawerBody>
      </>
    );
  }
  if (!entry.data) {
    return (
      <>
        <DrawerHeader>
          <DrawerTitle>Journal entry</DrawerTitle>
        </DrawerHeader>
        <DrawerBody>
          <p className="text-sm text-fg-muted">Entry not found.</p>
        </DrawerBody>
      </>
    );
  }

  const e = entry.data;
  const debits = (e.lines ?? []).reduce((s, l) => s + Number(l.debit), 0);
  const credits = (e.lines ?? []).reduce((s, l) => s + Number(l.credit), 0);
  const balanced = Math.abs(debits - credits) < 0.01;
  const reversed = Boolean(e.reversedById);

  return (
    <>
      <DrawerHeader>
        <div className="flex items-start gap-2">
          <ScrollText className="h-4 w-4 mt-1 text-info" />
          <div className="flex-1 min-w-0">
            <DrawerTitle className="font-mono">{e.number}</DrawerTitle>
            <DrawerDescription>
              {formatDateTime(e.entryDate)} · posted{" "}
              {formatDateTime(e.postedAt)}
              {e.postedBy && ` by ${e.postedBy.name}`}
            </DrawerDescription>
          </div>
          <Badge variant={balanced ? "success" : "danger"}>
            {balanced ? "Balanced" : "Out of balance"}
          </Badge>
        </div>
      </DrawerHeader>

      <DrawerBody>
        {/* Source + reversal state */}
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-md border border-default bg-surface-2 p-2">
            <div className="text-[10px] uppercase tracking-wider text-fg-subtle">
              Source
            </div>
            <div className="font-mono mt-0.5">{e.source}</div>
            {e.sourceRefId && (
              <div className="text-[10px] text-fg-muted mt-1 truncate">
                {e.sourceRefType} ·{" "}
                <span className="font-mono">{e.sourceRefId.slice(0, 8)}</span>
              </div>
            )}
          </div>
          <div className="rounded-md border border-default bg-surface-2 p-2">
            <div className="text-[10px] uppercase tracking-wider text-fg-subtle">
              Reversal
            </div>
            {reversed ? (
              <>
                <Badge variant="muted">Reversed</Badge>
                <div className="text-[10px] text-fg-muted mt-1 font-mono">
                  by {e.reversedById?.slice(0, 8)}
                </div>
              </>
            ) : (
              <span className="text-fg-muted">Not reversed</span>
            )}
          </div>
        </div>

        {e.memo && (
          <div className="text-xs">
            <div className="text-[10px] uppercase tracking-wider text-fg-subtle mb-1">
              Memo
            </div>
            <div className="text-fg">{e.memo}</div>
          </div>
        )}

        {/* Lines */}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-fg-subtle mb-1.5">
            Lines
          </div>
          <table className="w-full text-xs">
            <thead className="text-left text-[10px] uppercase tracking-wider text-fg-subtle">
              <tr>
                <th className="py-1.5 px-2">Account</th>
                <th className="py-1.5 px-2 text-right">Debit</th>
                <th className="py-1.5 px-2 text-right">Credit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-default">
              {(e.lines ?? []).map((l) => (
                <tr key={l.id} className="align-top">
                  <td className="py-1.5 px-2">
                    <div className="font-mono text-[10px] text-fg-muted">
                      {l.account?.code}
                    </div>
                    <div>{l.account?.name ?? "—"}</div>
                    {l.memo && (
                      <div className="text-[10px] text-fg-subtle mt-0.5">
                        {l.memo}
                      </div>
                    )}
                  </td>
                  <td className="py-1.5 px-2 text-right font-mono">
                    {Number(l.debit) > 0 ? formatMoney(Number(l.debit)) : "—"}
                  </td>
                  <td className="py-1.5 px-2 text-right font-mono">
                    {Number(l.credit) > 0 ? formatMoney(Number(l.credit)) : "—"}
                  </td>
                </tr>
              ))}
              <tr className="bg-surface-2 font-semibold">
                <td className="py-1.5 px-2 text-[10px] uppercase tracking-wider text-fg-muted">
                  Total
                </td>
                <td className="py-1.5 px-2 text-right font-mono">
                  {formatMoney(debits)}
                </td>
                <td className="py-1.5 px-2 text-right font-mono">
                  {formatMoney(credits)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </DrawerBody>

      <DrawerFooter>
        <Button variant="outline" asChild>
          <a
            href={`/accounting/journal`}
            className="inline-flex items-center gap-1"
          >
            <ArrowUpRight className="h-3 w-3" />
            Open in Journal
          </a>
        </Button>
        {!reversed && e.source !== "REVERSAL" && (
          <Button
            variant="destructive"
            onClick={onReverse}
            disabled={reverse.isPending}
          >
            <RotateCcw className="h-3 w-3" />
            Reverse
          </Button>
        )}
      </DrawerFooter>
    </>
  );
}
