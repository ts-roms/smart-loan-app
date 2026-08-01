import {
  useApproveDemandLetter,
  useCloseDemandLetter,
  useDemandCandidates,
  useDemandLetters,
  useDispatchDemandLetter,
  useDraftDemandLetters,
  useMyPermissions,
} from "@loan/api-client";
import type {
  DemandLetterStage,
  DemandLetterStatus,
  DemandLetterWithLoan,
} from "@loan/shared-types";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
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
import { formatDate, formatDateTime, formatMoney } from "@loan/shared-utils";
import {
  CheckCircle2,
  FileText,
  MailWarning,
  ScrollText,
  Send,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { findArticle, TourButton } from "../../help";

const STAGES: Array<{
  value: DemandLetterStage;
  label: string;
  threshold: number;
}> = [
  { value: "FIRST", label: "First (60d+)", threshold: 60 },
  { value: "FINAL", label: "Final (90d+)", threshold: 90 },
  { value: "ATTORNEY_FIRST", label: "Attorney First (120d+)", threshold: 120 },
  { value: "ATTORNEY_FINAL", label: "Attorney Final (150d+)", threshold: 150 },
];

const STAGE_LABEL: Record<DemandLetterStage, string> = {
  FIRST: "First",
  FINAL: "Final",
  ATTORNEY_FIRST: "Atty. First",
  ATTORNEY_FINAL: "Atty. Final",
};

const STATUS_VARIANT: Record<
  DemandLetterStatus,
  "muted" | "warning" | "success" | "danger"
> = {
  DRAFTED: "warning",
  APPROVED: "muted",
  DISPATCHED: "muted",
  RESPONDED: "success",
  WAIVED: "danger",
};

/**
 * Demand Letters page — FRD §3.6 implementation.
 *
 * Top section: filter by stage, click Display to identify candidates,
 * tick-box selection + Generate to create DRAFTED rows.
 *
 * Bottom section: list all letters (drafted/dispatched/closed) with the
 * three actions (Dispatch / Respond / Waive) per row.
 */
export function DemandLettersPage() {
  const me = useMyPermissions();
  const canManage = (me.data?.permissions ?? []).includes(
    "collections.demand_letter",
  );

  const [stage, setStage] = useState<DemandLetterStage>("FIRST");
  const [statusFilter, setStatusFilter] = useState<DemandLetterStatus | "ALL">(
    "ALL",
  );
  const [candidatesVisible, setCandidatesVisible] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const candidates = useDemandCandidates(stage, { enabled: candidatesVisible });
  const letters = useDemandLetters({
    stage,
    status: statusFilter === "ALL" ? undefined : statusFilter,
  });
  const draft = useDraftDemandLetters();
  const toast = useToast();
  const confirm = useConfirm();

  const onDisplay = () => {
    setSelected(new Set());
    setCandidatesVisible(true);
    void candidates.refetch();
  };

  const toggle = (loanId: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(loanId)) next.delete(loanId);
      else next.add(loanId);
      return next;
    });

  const onSelectAll = () => {
    if (!candidates.data) return;
    setSelected(new Set(candidates.data.map((c) => c.loanId)));
  };

  const onGenerate = async () => {
    if (selected.size === 0) {
      toast.error("Select at least one row");
      return;
    }
    const ok = await confirm({
      title: `Generate ${selected.size} ${STAGE_LABEL[stage]} demand letter(s)?`,
      message:
        "Letters will be created as DRAFTED. You can review each one before dispatching.",
      confirmLabel: "Generate",
    });
    if (!ok) return;
    try {
      const r = await draft.mutateAsync({
        loanIds: Array.from(selected),
        stage,
      });
      toast.success(`Generated ${r.created} draft letter(s)`);
      setSelected(new Set());
      setCandidatesVisible(false);
      setStatusFilter("DRAFTED");
    } catch (err) {
      toast.error((err as Error).message ?? "Generation failed");
    }
  };

  return (
    <div className="space-y-4">
      {/* Header card */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <MailWarning className="h-4 w-4 text-amber-300" />
            Demand letters
          </CardTitle>
          <TourButton
            tourId="demand-letters"
            steps={findArticle("demand-letters")?.tour ?? []}
          />
        </CardHeader>
        <CardContent>
          <p className="text-xs text-white/55">
            FRD §3.6 — formal escalation when a loan is materially overdue.
            First letter at 60 days, Final at 90, attorney variants at 120 and
            150. Generate in batches, dispatch individually, waive or mark
            responded as cases resolve.
          </p>
        </CardContent>
      </Card>

      {/* Candidate-identification card */}
      {canManage && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <ScrollText className="h-4 w-4" />
              Identify candidates
            </CardTitle>
            <div className="flex items-center gap-2">
              <span data-tour="dl-stage">
                <Select
                  value={stage}
                  onValueChange={(v) => setStage(v as DemandLetterStage)}
                >
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STAGES.map((s) => (
                      <SelectItem key={s.value} value={s.value}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={onDisplay}
                data-tour="dl-display"
              >
                Display
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {!candidatesVisible ? (
              <p className="text-sm text-white/55">
                Click Display to fetch loans eligible for a {STAGE_LABEL[stage]}{" "}
                demand letter.
              </p>
            ) : candidates.isLoading ? (
              <SkeletonCard />
            ) : (candidates.data ?? []).length === 0 ? (
              <p className="text-sm text-white/55">
                No loans currently meet the {STAGE_LABEL[stage]} threshold.
                Either nothing is overdue past the window, or every candidate
                already has an active letter at this stage.
              </p>
            ) : (
              <>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-white/65">
                    {candidates.data!.length} candidate(s) · {selected.size}{" "}
                    selected
                  </span>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={onSelectAll}>
                      Select all
                    </Button>
                    <Button
                      size="sm"
                      onClick={onGenerate}
                      disabled={draft.isPending || selected.size === 0}
                    >
                      <FileText className="h-3 w-3" />
                      {draft.isPending
                        ? "Generating…"
                        : `Generate ${selected.size || ""}`}
                    </Button>
                  </div>
                </div>
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wider text-white/45">
                    <tr>
                      <th className="py-2 px-2 w-8"></th>
                      <th className="py-2 px-2">Loan</th>
                      <th className="py-2 px-2">Customer</th>
                      <th className="py-2 px-2 text-right">Total owed</th>
                      <th className="py-2 px-2 text-right">Days overdue</th>
                      <th className="py-2 px-2">Last letter</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {candidates.data!.map((c) => (
                      <tr key={c.loanId} className="hover:bg-white/[0.03]">
                        <td className="py-2 px-2">
                          <input
                            type="checkbox"
                            checked={selected.has(c.loanId)}
                            onChange={() => toggle(c.loanId)}
                            aria-label={`Select ${c.loanNumber}`}
                          />
                        </td>
                        <td className="py-2 px-2 font-mono text-xs">
                          <Link
                            to={`/loans/${c.loanNumber}`}
                            className="text-sky-300 hover:underline"
                          >
                            {c.loanNumber}
                          </Link>
                        </td>
                        <td className="py-2 px-2">{c.customerName}</td>
                        <td className="py-2 px-2 text-right font-mono">
                          {formatMoney(c.totalOwed)}
                        </td>
                        <td className="py-2 px-2 text-right text-rose-300 font-mono">
                          {c.daysOverdue}
                        </td>
                        <td className="py-2 px-2 text-[10px] text-white/55">
                          {c.lastLetterAtStageAt
                            ? formatDate(c.lastLetterAtStageAt)
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Letter list */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <FileText className="h-4 w-4" />
            Letters
          </CardTitle>
          <span data-tour="dl-status-filter">
            <Select
              value={statusFilter}
              onValueChange={(v) =>
                setStatusFilter(v as DemandLetterStatus | "ALL")
              }
            >
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All statuses</SelectItem>
                <SelectItem value="DRAFTED">Drafted</SelectItem>
                <SelectItem value="APPROVED">Approved</SelectItem>
                <SelectItem value="DISPATCHED">Dispatched</SelectItem>
                <SelectItem value="RESPONDED">Responded</SelectItem>
                <SelectItem value="WAIVED">Waived</SelectItem>
              </SelectContent>
            </Select>
          </span>
        </CardHeader>
        <CardContent>
          {letters.isLoading ? (
            <SkeletonCard />
          ) : (letters.data ?? []).length === 0 ? (
            <p className="text-sm text-white/55">
              No letters at this stage yet.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wider text-white/45">
                <tr>
                  <th className="py-2 px-2">Loan</th>
                  <th className="py-2 px-2">Stage</th>
                  <th className="py-2 px-2 text-right">Total owed</th>
                  <th className="py-2 px-2">Deadline</th>
                  <th className="py-2 px-2">Status</th>
                  <th className="py-2 px-2">Drafted</th>
                  <th className="py-2 px-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {letters.data!.map((l) => (
                  <LetterRow key={l.id} letter={l} canManage={canManage} />
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function LetterRow({
  letter,
  canManage,
}: {
  letter: DemandLetterWithLoan;
  canManage: boolean;
}) {
  const dispatch = useDispatchDemandLetter();
  const approve = useApproveDemandLetter();
  const close = useCloseDemandLetter();
  const toast = useToast();
  const askPrompt = usePrompt();
  const [dispatching, setDispatching] = useState(false);
  const [showLetter, setShowLetter] = useState(false);

  const onApprove = async () => {
    const note = await askPrompt({
      title: "Approve demand letter",
      message:
        "FRD §3.6.5 — signing off as Operations Manager (or Lawyer for attorney variants). Optional note for the audit trail.",
      label: "Approval note",
      placeholder: "Reviewed contents; approved for dispatch.",
      confirmLabel: "Approve",
    });
    if (note === null) return;
    try {
      await approve.mutateAsync({ id: letter.id, note: note || undefined });
      toast.success("Letter approved · ready for dispatch");
    } catch (err) {
      toast.error((err as Error).message ?? "Approval failed");
    }
  };

  const onDispatch = async () => {
    setDispatching(true);
    try {
      const channel = await askPrompt({
        title: "Dispatch channel",
        message:
          "EMAIL / SMS / COURIER / POST — how is this letter being sent?",
        label: "Channel",
        placeholder: "EMAIL",
        defaultValue: "EMAIL",
        confirmLabel: "Next",
      });
      if (channel === null) {
        setDispatching(false);
        return;
      }
      const ref = await askPrompt({
        title: "Reference id (optional)",
        message:
          "Tracking number / message id / mail receipt — for the audit trail.",
        label: "Ref",
        placeholder: "tracking#",
        confirmLabel: "Dispatch",
      });
      if (ref === null) {
        setDispatching(false);
        return;
      }
      await dispatch.mutateAsync({
        id: letter.id,
        channel: channel.toUpperCase(),
        ref: ref || undefined,
      });
      toast.success("Letter dispatched · borrower notified");
    } catch (err) {
      toast.error((err as Error).message ?? "Dispatch failed");
    } finally {
      setDispatching(false);
    }
  };

  const onClose = async (status: "RESPONDED" | "WAIVED") => {
    const reason = await askPrompt({
      title: status === "WAIVED" ? "Waive this letter" : "Mark as responded",
      message:
        status === "WAIVED"
          ? "Why is this letter being waived? (e.g. ongoing arrangement, special handling)"
          : "How did the borrower respond? (e.g. full payment received, restructure approved)",
      label: "Reason",
      placeholder: "Reason for audit trail",
      confirmLabel: status === "WAIVED" ? "Waive" : "Mark responded",
    });
    if (reason === null) return;
    try {
      await close.mutateAsync({ id: letter.id, status, reason });
      toast.success(status === "WAIVED" ? "Letter waived" : "Letter closed");
    } catch (err) {
      toast.error((err as Error).message ?? "Close failed");
    }
  };

  const isOpen =
    letter.status === "DRAFTED" ||
    letter.status === "APPROVED" ||
    letter.status === "DISPATCHED";

  return (
    <>
      <tr className="hover:bg-white/[0.03]">
        <td className="py-2 px-2 font-mono text-xs">
          <Link
            to={`/loans/${letter.loan.number}`}
            className="text-sky-300 hover:underline"
          >
            {letter.loan.number}
          </Link>
        </td>
        <td className="py-2 px-2">
          <Badge variant="muted">{STAGE_LABEL[letter.stage]}</Badge>
        </td>
        <td className="py-2 px-2 text-right font-mono">
          {formatMoney(Number(letter.totalOwed))}
        </td>
        <td className="py-2 px-2 text-xs">
          {formatDate(letter.paymentDeadline)}
        </td>
        <td className="py-2 px-2">
          <Badge variant={STATUS_VARIANT[letter.status]}>{letter.status}</Badge>
        </td>
        <td className="py-2 px-2 text-[10px] text-white/55">
          {formatDateTime(letter.draftedAt)}
        </td>
        <td className="py-2 px-2 text-right">
          <div className="inline-flex gap-1">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowLetter(true)}
            >
              View
            </Button>
            {canManage && letter.status === "DRAFTED" && (
              <Button
                size="sm"
                variant="outline"
                onClick={onApprove}
                disabled={approve.isPending}
              >
                <CheckCircle2 className="h-3 w-3" />
                Approve
              </Button>
            )}
            {canManage && letter.status === "APPROVED" && (
              <Button size="sm" onClick={onDispatch} disabled={dispatching}>
                <Send className="h-3 w-3" />
                Dispatch
              </Button>
            )}
            {canManage && isOpen && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onClose("RESPONDED")}
                >
                  <CheckCircle2 className="h-3 w-3" />
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onClose("WAIVED")}
                >
                  Waive
                </Button>
              </>
            )}
          </div>
        </td>
      </tr>
      {showLetter && (
        <LetterDrawer
          letter={letter}
          open={showLetter}
          onClose={() => setShowLetter(false)}
        />
      )}
    </>
  );
}

function LetterDrawer({
  letter,
  open,
  onClose,
}: {
  letter: DemandLetterWithLoan;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Drawer open={open} onOpenChange={(o) => !o && onClose()}>
      <DrawerContent className="max-w-2xl">
        <DrawerHeader>
          <DrawerTitle>
            {STAGE_LABEL[letter.stage]} demand letter · {letter.loan.number}
          </DrawerTitle>
          <DrawerDescription>
            Drafted {formatDateTime(letter.draftedAt)} · status {letter.status}{" "}
            · deadline {formatDate(letter.paymentDeadline)}
          </DrawerDescription>
        </DrawerHeader>
        <DrawerBody>
          <pre className="whitespace-pre-wrap text-xs text-white/85 font-sans leading-relaxed">
            {letter.body}
          </pre>
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}
