import {
  useApproveStep,
  useLoanApprovals,
  useMyPermissions,
  useRejectStep,
} from "@loan/api-client";
import type { LoanApproval, LoanApplication } from "@loan/shared-types";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  SkeletonCard,
  useToast,
} from "@loan/ui";
import { formatDateTime } from "@loan/shared-utils";
import {
  CheckCircle2,
  Circle,
  ListChecks,
  ThumbsDown,
  ThumbsUp,
  XCircle,
} from "lucide-react";
import { useState } from "react";

/**
 * Approval-chain panel for loan detail pages.
 *
 * Three visual states per row:
 *   • APPROVED → check icon, approver name + timestamp + notes
 *   • current pending → highlighted, "Approve / Reject" buttons if the
 *     current user holds the row's requiredPermission (or has it via
 *     active delegation — the API has already merged delegation perms
 *     into /auth/me/permissions, so we just check membership)
 *   • later pending → grayed out, waiting their turn
 *   • REJECTED → red icon, terminal state
 *
 * Hidden entirely when the loan has no chain (`currentApprovalStep` is
 * null AND there are zero approval rows). Legacy single-decide loans
 * keep their existing UI.
 */
export function ApprovalChainPanel({ loan }: { loan: LoanApplication }) {
  // Use the loan's number for the URL — the API resolves either form,
  // but the human ID is the new convention.
  const idForUrl = loan.number;
  const approvals = useLoanApprovals(idForUrl);
  const myPerms = useMyPermissions();

  // Don't render anything if the loan has no chain at all. We check both
  // the column AND the result array so we don't flash an empty panel
  // during the initial load.
  const rows = approvals.data ?? [];
  if (approvals.isLoading) {
    return <SkeletonCard />;
  }
  if (rows.length === 0) {
    return null;
  }

  const myPermSet = new Set(myPerms.data?.permissions ?? []);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-primary" />
          Approval chain
        </CardTitle>
        <p className="text-xs text-fg-muted">
          Sequential workflow. Each step must be approved by someone who holds
          the matching permission (or a stand-in via active delegation).
        </p>
      </CardHeader>
      <CardContent>
        <ol className="space-y-3">
          {rows.map((row) => {
            const isCurrent =
              row.status === "PENDING" &&
              row.stepOrder === loan.currentApprovalStep;
            const canAct = isCurrent && myPermSet.has(row.requiredPermission);
            return (
              <ApprovalRow
                key={row.id}
                row={row}
                isCurrent={isCurrent}
                canAct={canAct}
                loanIdForUrl={idForUrl}
              />
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}

// ─── Row ─────────────────────────────────────────────────────────────

function ApprovalRow({
  row,
  isCurrent,
  canAct,
  loanIdForUrl,
}: {
  row: LoanApproval;
  isCurrent: boolean;
  canAct: boolean;
  loanIdForUrl: string;
}) {
  const toast = useToast();
  const approve = useApproveStep(loanIdForUrl);
  const reject = useRejectStep(loanIdForUrl);
  const [approveOpen, setApproveOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [notes, setNotes] = useState("");

  const Icon = (() => {
    if (row.status === "APPROVED") return CheckCircle2;
    if (row.status === "REJECTED") return XCircle;
    return Circle;
  })();
  const iconClass = (() => {
    if (row.status === "APPROVED") return "text-success";
    if (row.status === "REJECTED") return "text-danger";
    if (isCurrent) return "text-primary";
    return "text-fg-subtle";
  })();

  return (
    <li
      className={
        "rounded-md border p-3 flex items-start gap-3 transition-colors " +
        (isCurrent
          ? "border-primary/40 bg-primary-soft"
          : "border-default bg-surface-2")
      }
    >
      <Icon className={`h-5 w-5 mt-0.5 shrink-0 ${iconClass}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[10px] font-mono text-fg-subtle uppercase tracking-wider">
              Step {row.stepOrder}
            </span>
            <span className="text-sm font-medium text-fg truncate">
              {row.stepLabel}
            </span>
          </div>
          <ApprovalStatusBadge status={row.status} isCurrent={isCurrent} />
        </div>
        <div className="text-[11px] text-fg-subtle mt-0.5 font-mono">
          requires <code>{row.requiredPermission}</code>
        </div>

        {/* Past approval — show who/when/why */}
        {row.status !== "PENDING" && row.approver && (
          <div className="mt-2 text-xs text-fg-muted space-y-1">
            <div>
              {row.status === "REJECTED" ? "Rejected by" : "Approved by"}{" "}
              <span className="text-fg">{row.approver.name}</span>
              {row.signedUnderDelegationId && (
                <span className="text-fg-subtle"> (as delegate)</span>
              )}
              {row.approvedAt && (
                <span className="text-fg-subtle">
                  {" "}
                  · {formatDateTime(row.approvedAt)}
                </span>
              )}
            </div>
            {row.notes && (
              <div className="rounded border border-default bg-surface-3 px-2 py-1.5 text-xs text-fg">
                <span className="text-fg-subtle">Note: </span>
                {row.notes}
              </div>
            )}
          </div>
        )}

        {/* Action buttons — only the current pending step shows them */}
        {canAct && (
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                setNotes("");
                setApproveOpen(true);
              }}
            >
              <ThumbsUp className="h-3.5 w-3.5" />
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setNotes("");
                setRejectOpen(true);
              }}
            >
              <ThumbsDown className="h-3.5 w-3.5" />
              Reject
            </Button>
          </div>
        )}
        {isCurrent && !canAct && (
          <div className="mt-2 text-[11px] text-fg-subtle">
            You don't hold the required permission for this step.
          </div>
        )}
      </div>

      {/* Approve dialog — notes optional */}
      <Dialog open={approveOpen} onOpenChange={setApproveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve “{row.stepLabel}”?</DialogTitle>
            <DialogDescription>
              You can leave a note for the next step (or post-approval audit).
              Notes are optional.
            </DialogDescription>
          </DialogHeader>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional notes — context, conditions, follow-ups…"
            rows={4}
            className="w-full field-chrome rounded-md px-3 py-2 text-sm placeholder:text-fg-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setApproveOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={approve.isPending}
              onClick={async () => {
                try {
                  await approve.mutateAsync({
                    notes: notes.trim() || undefined,
                  });
                  toast.success(`Step ${row.stepOrder} approved.`);
                  setApproveOpen(false);
                } catch (err) {
                  toast.error((err as Error).message ?? "Approve failed.");
                }
              }}
            >
              {approve.isPending ? "Approving…" : "Approve step"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject dialog — notes required */}
      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject “{row.stepLabel}”?</DialogTitle>
            <DialogDescription>
              Rejection is terminal — the loan flips to REJECTED. Notes are
              required so the borrower and audit trail have a reason.
            </DialogDescription>
          </DialogHeader>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Reason for rejection (required)…"
            rows={4}
            className="w-full field-chrome rounded-md px-3 py-2 text-sm placeholder:text-fg-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRejectOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={reject.isPending || notes.trim().length === 0}
              onClick={async () => {
                try {
                  await reject.mutateAsync({ notes: notes.trim() });
                  toast.success("Loan rejected.");
                  setRejectOpen(false);
                } catch (err) {
                  toast.error((err as Error).message ?? "Reject failed.");
                }
              }}
            >
              {reject.isPending ? "Rejecting…" : "Reject loan"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}

function ApprovalStatusBadge({
  status,
  isCurrent,
}: {
  status: LoanApproval["status"];
  isCurrent: boolean;
}) {
  if (status === "APPROVED") return <Badge variant="success">Approved</Badge>;
  if (status === "REJECTED") return <Badge variant="danger">Rejected</Badge>;
  if (status === "SKIPPED") return <Badge variant="muted">Skipped</Badge>;
  if (isCurrent) return <Badge variant="warning">Current</Badge>;
  return <Badge variant="muted">Pending</Badge>;
}
