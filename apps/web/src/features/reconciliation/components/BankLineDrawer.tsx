import {
  useBankLineCandidates,
  useMatchLine,
  type BankStatementLine,
} from "@loan/api-client";
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
  Input,
  Label,
  SkeletonLine,
  useToast,
} from "@loan/ui";
import { formatDate, formatMoney } from "@loan/shared-utils";
import { Banknote, CheckCircle2, CircleHelp, Link2 } from "lucide-react";
import { useState, type ReactNode } from "react";

/**
 * Inspector drawer for a bank statement line. The trigger sits on the
 * `Unmatched` status cell — clicking opens a drawer with the suggested
 * matches (scored, returned by the API) plus a manual-match fallback.
 *
 * Why a drawer? The full statement table is wide and dense; running the
 * candidate-suggestion query per row would be wasteful. Lazy-fetching when
 * the user opts in to inspect a single line is much cheaper and gives
 * them context (description, ref, amount) right next to the candidate
 * list.
 */
export function BankLineLink({
  line,
  statementId,
  children,
}: {
  line: BankStatementLine;
  statementId: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 text-warning/80 hover:text-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60 rounded"
          aria-label="Inspect bank line"
        >
          {children}
        </button>
      </DrawerTrigger>
      <DrawerContent>
        <BankLineInspector
          line={line}
          statementId={statementId}
          onClose={() => setOpen(false)}
        />
      </DrawerContent>
    </Drawer>
  );
}

function BankLineInspector({
  line,
  statementId,
  onClose,
}: {
  line: BankStatementLine;
  statementId: string;
  onClose: () => void;
}) {
  const candidates = useBankLineCandidates(line.id);
  const matchLine = useMatchLine();
  const toast = useToast();

  // Manual fallback form
  const [manualType, setManualType] = useState("MANUAL");
  const [manualRefId, setManualRefId] = useState("");
  const [manualNote, setManualNote] = useState("");

  const amount = Number(line.amount);
  const isCredit = amount > 0;

  const onApplyCandidate = async (c: {
    type: string;
    refId: string;
    label: string;
  }) => {
    try {
      await matchLine.mutateAsync({
        lineId: line.id,
        statementId,
        type: c.type,
        refId: c.refId,
        note: c.label,
      });
      toast.success(`Matched · ${c.label}`);
      onClose();
    } catch (err) {
      toast.error((err as Error).message ?? "Match failed");
    }
  };

  const onApplyManual = async () => {
    if (!manualType.trim()) {
      toast.error("Pick a match type");
      return;
    }
    try {
      await matchLine.mutateAsync({
        lineId: line.id,
        statementId,
        type: manualType.trim(),
        refId: manualRefId.trim() || undefined,
        note: manualNote.trim() || undefined,
      });
      toast.success("Line matched manually");
      onClose();
    } catch (err) {
      toast.error((err as Error).message ?? "Match failed");
    }
  };

  return (
    <>
      <DrawerHeader>
        <div className="flex items-start gap-2">
          <Banknote className="h-5 w-5 mt-0.5 text-info" />
          <div className="flex-1 min-w-0">
            <DrawerTitle>Match bank line</DrawerTitle>
            <DrawerDescription>
              {formatDate(line.txnDate)} ·{" "}
              <span className={isCredit ? "text-success" : "text-danger"}>
                {formatMoney(amount)}
              </span>
              {line.reference && (
                <>
                  {" · "}
                  <span className="font-mono">{line.reference}</span>
                </>
              )}
            </DrawerDescription>
          </div>
        </div>
      </DrawerHeader>

      <DrawerBody>
        {/* The line itself */}
        <div className="rounded-md border border-default bg-surface-2 p-2.5 text-xs">
          <div className="text-[10px] uppercase tracking-wider text-fg-subtle mb-1">
            Description
          </div>
          <p className="text-fg">{line.description}</p>
        </div>

        {/* Suggested matches */}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-fg-subtle mb-1.5 flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3" />
            Suggested matches
          </div>
          {candidates.isLoading ? (
            <div className="space-y-2">
              <SkeletonLine />
              <SkeletonLine />
            </div>
          ) : (candidates.data ?? []).length === 0 ? (
            <p className="text-xs text-fg-muted inline-flex items-center gap-1">
              <CircleHelp className="h-3 w-3" />
              No candidates within ±2 days at exact amount. Use the manual form
              below.
            </p>
          ) : (
            <div className="rounded-md border border-default bg-surface-2 divide-y divide-default">
              {(candidates.data ?? []).map((c) => (
                <div
                  key={`${c.type}-${c.refId}`}
                  className="px-2.5 py-2 text-xs flex items-start justify-between gap-2"
                >
                  <div className="min-w-0">
                    <div className="font-medium">{c.label}</div>
                    <div className="text-[10px] text-fg-muted truncate">
                      {c.detail}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge
                      variant={
                        c.score >= 0.95
                          ? "success"
                          : c.score >= 0.8
                            ? "warning"
                            : "muted"
                      }
                    >
                      {(c.score * 100).toFixed(0)}%
                    </Badge>
                    <Button
                      size="sm"
                      onClick={() => onApplyCandidate(c)}
                      disabled={matchLine.isPending}
                    >
                      <Link2 className="h-3 w-3" />
                      Match
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Manual fallback */}
        <div className="rounded-md border border-default bg-surface-2 p-2.5">
          <div className="text-[10px] uppercase tracking-wider text-fg-subtle mb-2">
            Manual match
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Type</Label>
              <Input
                value={manualType}
                onChange={(e) => setManualType(e.target.value)}
                placeholder="MANUAL / LoanPayment / LoanDisbursement"
              />
            </div>
            <div>
              <Label>Reference id (optional)</Label>
              <Input
                value={manualRefId}
                onChange={(e) => setManualRefId(e.target.value)}
                placeholder="uuid"
              />
            </div>
          </div>
          <div className="mt-2">
            <Label>Note (optional)</Label>
            <Input
              value={manualNote}
              onChange={(e) => setManualNote(e.target.value)}
              placeholder="e.g. monthly bank fee"
            />
          </div>
          <div className="mt-2 flex justify-end">
            <Button
              size="sm"
              variant="outline"
              onClick={onApplyManual}
              disabled={matchLine.isPending || !manualType.trim()}
            >
              {matchLine.isPending ? "Matching…" : "Match manually"}
            </Button>
          </div>
        </div>
      </DrawerBody>

      <DrawerFooter>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </DrawerFooter>
    </>
  );
}
