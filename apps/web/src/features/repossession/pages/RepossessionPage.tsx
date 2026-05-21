import {
  useAdvanceRepossession,
  useMyPermissions,
  useOpenRepossession,
  useRepossessionCases,
  useRepossessionOutstanding,
} from "@loan/api-client";
import type {
  RepossessionCaseWithLoan,
  RepossessionStatus,
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
  Input,
  Label,
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
  Car,
  CheckCircle2,
  Gavel,
  ShieldAlert,
  Truck,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";

import { findArticle, TourButton } from "../../help";

const STATUS_LABEL: Record<RepossessionStatus, string> = {
  IDENTIFIED: "Identified",
  BM_APPROVED: "BM approved",
  CREDIT_HEAD_APPROVED: "Credit Head approved",
  LEGAL_APPROVED: "Legal approved",
  AGENT_ASSIGNED: "Agent assigned",
  RECOVERED: "Recovered",
  AUCTIONED: "Auctioned",
  CLOSED: "Closed",
  CANCELLED: "Cancelled",
};

const STATUS_VARIANT: Record<
  RepossessionStatus,
  "muted" | "warning" | "success" | "danger"
> = {
  IDENTIFIED: "warning",
  BM_APPROVED: "warning",
  CREDIT_HEAD_APPROVED: "warning",
  LEGAL_APPROVED: "warning",
  AGENT_ASSIGNED: "muted",
  RECOVERED: "muted",
  AUCTIONED: "success",
  CLOSED: "success",
  CANCELLED: "danger",
};

/**
 * Repossession workflow page — FRD §3.7. Top: filter + identify card.
 * Bottom: list of all active + closed cases, each row showing its
 * current state and the next-action button (gated by per-step perms).
 */
export function RepossessionPage() {
  const me = useMyPermissions();
  const perms = new Set(me.data?.permissions ?? []);
  const [statusFilter, setStatusFilter] = useState<RepossessionStatus | "ALL">(
    "ALL",
  );
  const [identifyOpen, setIdentifyOpen] = useState(false);

  const cases = useRepossessionCases(
    statusFilter === "ALL" ? {} : { status: statusFilter },
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-rose-300" />
            Repossession
          </CardTitle>
          <div className="flex items-center gap-2">
            <TourButton
              tourId="repossession"
              steps={findArticle("repossession")?.tour ?? []}
            />
            {perms.has("repossession.identify") && (
              <span data-tour="repo-identify">
                <Button size="sm" onClick={() => setIdentifyOpen(true)}>
                  <Car className="h-3 w-3" />
                  Identify case
                </Button>
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-white/55">
            FRD §3.7 — formal vehicle recovery process. Each case advances
            through BM → Credit Head → Legal approval before an agent is
            dispatched. After recovery, the vehicle is auctioned and any
            deficiency is booked to bad debt.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm">Cases</CardTitle>
          <Select
            value={statusFilter}
            onValueChange={(v) =>
              setStatusFilter(v as RepossessionStatus | "ALL")
            }
          >
            <SelectTrigger className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All statuses</SelectItem>
              {(Object.keys(STATUS_LABEL) as RepossessionStatus[]).map((s) => (
                <SelectItem key={s} value={s}>
                  {STATUS_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent>
          {cases.isLoading ? (
            <SkeletonCard />
          ) : (cases.data ?? []).length === 0 ? (
            <p className="text-sm text-white/55">No cases at this status.</p>
          ) : (
            <table className="w-full text-sm" data-tour="repo-cases">
              <thead className="text-left text-xs uppercase tracking-wider text-white/45">
                <tr>
                  <th className="py-2 px-2">Loan</th>
                  <th className="py-2 px-2">Status</th>
                  <th className="py-2 px-2">Reason</th>
                  <th className="py-2 px-2">Identified</th>
                  <th className="py-2 px-2 text-right">Outstanding</th>
                  <th className="py-2 px-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {cases.data!.map((c) => (
                  <CaseRow key={c.id} c={c} perms={perms} />
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {identifyOpen && (
        <IdentifyDialog onClose={() => setIdentifyOpen(false)} />
      )}
    </div>
  );
}

function CaseRow({
  c,
  perms,
}: {
  c: RepossessionCaseWithLoan;
  perms: Set<string>;
}) {
  return (
    <tr className="hover:bg-white/[0.03]">
      <td className="py-2 px-2 font-mono text-xs">
        <Link
          to={`/loans/${c.loan.number}`}
          className="text-sky-300 hover:underline"
        >
          {c.loan.number}
        </Link>
      </td>
      <td className="py-2 px-2">
        <Badge variant={STATUS_VARIANT[c.status]}>
          {STATUS_LABEL[c.status]}
        </Badge>
      </td>
      <td className="py-2 px-2 text-xs max-w-xs truncate">{c.reason}</td>
      <td className="py-2 px-2 text-[10px] text-white/55">
        {formatDateTime(c.identifiedAt)}
      </td>
      <td className="py-2 px-2 text-right font-mono text-xs">
        {c.outstandingAtRecovery
          ? formatMoney(Number(c.outstandingAtRecovery))
          : "—"}
      </td>
      <td className="py-2 px-2 text-right">
        <CaseActions c={c} perms={perms} />
      </td>
    </tr>
  );
}

function CaseActions({
  c,
  perms,
}: {
  c: RepossessionCaseWithLoan;
  perms: Set<string>;
}) {
  const advance = useAdvanceRepossession();
  const toast = useToast();
  const confirm = useConfirm();
  const askPrompt = usePrompt();
  const outstanding = useRepossessionOutstanding(
    c.status === "AGENT_ASSIGNED" ? c.id : null,
  );

  const onSimpleApprove = async (
    action: "bm-approve" | "credit-approve" | "legal-approve",
    label: string,
  ) => {
    const note = await askPrompt({
      title: `${label} approval`,
      message: "Optional note for the audit trail.",
      label: "Note",
      placeholder: "",
      confirmLabel: "Approve",
    });
    if (note === null) return;
    try {
      await advance.mutateAsync({
        id: c.id,
        action,
        body: { note: note || undefined },
      });
      toast.success(`${label} approved`);
    } catch (err) {
      toast.error((err as Error).message ?? "Approval failed");
    }
  };

  const onAssignAgent = async () => {
    const agentName = await askPrompt({
      title: "Assign repossession agent",
      message: "Agent / firm to dispatch.",
      label: "Agent name",
      placeholder: "Acme Recovery Services",
      confirmLabel: "Next",
    });
    if (agentName === null) return;
    const agentContact = await askPrompt({
      title: "Agent contact",
      message: "Phone / email for follow-up.",
      label: "Contact",
      placeholder: "+63…",
      confirmLabel: "Assign",
    });
    if (agentContact === null) return;
    try {
      await advance.mutateAsync({
        id: c.id,
        action: "assign-agent",
        body: { agentName, agentContact },
      });
      toast.success("Agent assigned");
    } catch (err) {
      toast.error((err as Error).message ?? "Assign failed");
    }
  };

  const [recoverOpen, setRecoverOpen] = useState(false);
  const [auctionOpen, setAuctionOpen] = useState(false);

  const onCancel = async () => {
    const reason = await askPrompt({
      title: "Cancel repossession case",
      message:
        "Why is this case being cancelled? (e.g. borrower paid, restructure approved)",
      label: "Reason",
      placeholder: "Reason for audit trail",
      confirmLabel: "Cancel case",
    });
    if (reason === null) return;
    try {
      await advance.mutateAsync({
        id: c.id,
        action: "cancel",
        body: { reason },
      });
      toast.success("Case cancelled");
    } catch (err) {
      toast.error((err as Error).message ?? "Cancel failed");
    }
  };

  const buttons: React.ReactNode[] = [];

  if (c.status === "IDENTIFIED" && perms.has("repossession.bm_approve")) {
    buttons.push(
      <Button
        key="bm"
        size="sm"
        onClick={() => onSimpleApprove("bm-approve", "Branch Manager")}
      >
        <CheckCircle2 className="h-3 w-3" />
        BM approve
      </Button>,
    );
  }
  if (c.status === "BM_APPROVED" && perms.has("repossession.credit_approve")) {
    buttons.push(
      <Button
        key="credit"
        size="sm"
        onClick={() => onSimpleApprove("credit-approve", "Credit Head")}
      >
        <CheckCircle2 className="h-3 w-3" />
        Credit approve
      </Button>,
    );
  }
  if (
    c.status === "CREDIT_HEAD_APPROVED" &&
    perms.has("repossession.legal_approve")
  ) {
    buttons.push(
      <Button
        key="legal"
        size="sm"
        onClick={() => onSimpleApprove("legal-approve", "Legal")}
      >
        <CheckCircle2 className="h-3 w-3" />
        Legal approve
      </Button>,
    );
  }
  if (c.status === "LEGAL_APPROVED" && perms.has("repossession.assign_agent")) {
    buttons.push(
      <Button key="agent" size="sm" onClick={onAssignAgent}>
        <Truck className="h-3 w-3" />
        Assign agent
      </Button>,
    );
  }
  if (c.status === "AGENT_ASSIGNED" && perms.has("repossession.recover")) {
    buttons.push(
      <Button key="recover" size="sm" onClick={() => setRecoverOpen(true)}>
        <Car className="h-3 w-3" />
        Record recovery
      </Button>,
    );
  }
  if (c.status === "RECOVERED" && perms.has("repossession.auction")) {
    buttons.push(
      <Button key="auction" size="sm" onClick={() => setAuctionOpen(true)}>
        <Gavel className="h-3 w-3" />
        Auction
      </Button>,
    );
  }
  const canCancel =
    c.status !== "AUCTIONED" &&
    c.status !== "CLOSED" &&
    c.status !== "CANCELLED" &&
    perms.has("repossession.identify");
  if (canCancel) {
    buttons.push(
      <Button key="cancel" size="sm" variant="outline" onClick={onCancel}>
        <XCircle className="h-3 w-3" />
        Cancel
      </Button>,
    );
  }

  return (
    <>
      <div className="inline-flex gap-1">{buttons}</div>
      {recoverOpen && (
        <RecoverDialog
          caseId={c.id}
          suggestedOutstanding={outstanding.data?.totalOutstanding ?? 0}
          onClose={() => setRecoverOpen(false)}
        />
      )}
      {auctionOpen && (
        <AuctionDialog
          caseId={c.id}
          outstandingAtRecovery={Number(c.outstandingAtRecovery ?? 0)}
          onClose={() => setAuctionOpen(false)}
        />
      )}
    </>
  );
}

function IdentifyDialog({ onClose }: { onClose: () => void }) {
  const open = useOpenRepossession();
  const toast = useToast();
  const [loanId, setLoanId] = useState("");
  const [reason, setReason] = useState("");

  const onSubmit = async () => {
    if (!loanId || reason.trim().length < 3) {
      toast.error("Loan id + reason required");
      return;
    }
    try {
      await open.mutateAsync({ loanId, reason: reason.trim() });
      toast.success("Case opened");
      onClose();
    } catch (err) {
      toast.error((err as Error).message ?? "Open failed");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Identify repossession case</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-white/55">
            Opens a new case at status IDENTIFIED. The BM → Credit Head → Legal
            approval chain must complete before an agent can be dispatched. Only
            one active case per loan is allowed.
          </p>
          <div>
            <Label>Loan id (UUID)</Label>
            <Input
              value={loanId}
              onChange={(e) => setLoanId(e.target.value)}
              placeholder="e.g. 5a90df5d-…"
              className="font-mono"
            />
          </div>
          <div>
            <Label>Reason</Label>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="180 days overdue, no contact, demand letters unanswered"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={open.isPending}>
            {open.isPending ? "Opening…" : "Open case"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RecoverDialog({
  caseId,
  suggestedOutstanding,
  onClose,
}: {
  caseId: string;
  suggestedOutstanding: number;
  onClose: () => void;
}) {
  const advance = useAdvanceRepossession();
  const toast = useToast();
  const [vehicleCondition, setVehicleCondition] = useState("");
  const [vehicleMileage, setVehicleMileage] = useState(0);
  const [storageLocation, setStorageLocation] = useState("");
  const [vehiclePhotos, setVehiclePhotos] = useState("");
  const [outstanding, setOutstanding] = useState(suggestedOutstanding);

  const onSubmit = async () => {
    if (
      !vehicleCondition.trim() ||
      !storageLocation.trim() ||
      outstanding <= 0
    ) {
      toast.error("Condition, storage location, and outstanding required");
      return;
    }
    try {
      await advance.mutateAsync({
        id: caseId,
        action: "recover",
        body: {
          vehicleCondition: vehicleCondition.trim(),
          vehicleMileage: vehicleMileage || undefined,
          storageLocation: storageLocation.trim(),
          vehiclePhotos: vehiclePhotos
            ? vehiclePhotos
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : undefined,
          outstandingAtRecovery: outstanding,
        },
      });
      toast.success("Recovery recorded");
      onClose();
    } catch (err) {
      toast.error((err as Error).message ?? "Recovery failed");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record vehicle recovery</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-white/55">
            Snapshot the vehicle condition + outstanding balance so the auction
            settlement can compute deficiency cleanly.
          </p>
          <div>
            <Label>Vehicle condition</Label>
            <Input
              value={vehicleCondition}
              onChange={(e) => setVehicleCondition(e.target.value)}
              placeholder="Minor scratches on rear bumper, interior clean"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Mileage (km, optional)</Label>
              <Input
                type="number"
                min={0}
                value={vehicleMileage || ""}
                onChange={(e) => setVehicleMileage(Number(e.target.value))}
              />
            </div>
            <div>
              <Label>Outstanding balance at recovery (₱)</Label>
              <Input
                type="number"
                step="0.01"
                min={0.01}
                value={outstanding || ""}
                onChange={(e) => setOutstanding(Number(e.target.value))}
              />
            </div>
          </div>
          <div>
            <Label>Storage location</Label>
            <Input
              value={storageLocation}
              onChange={(e) => setStorageLocation(e.target.value)}
              placeholder="Main Warehouse Lot 12-B"
            />
          </div>
          <div>
            <Label>Photo URLs (comma-separated, optional)</Label>
            <Input
              value={vehiclePhotos}
              onChange={(e) => setVehiclePhotos(e.target.value)}
              placeholder="https://…, https://…"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={advance.isPending}>
            {advance.isPending ? "Recording…" : "Record recovery"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AuctionDialog({
  caseId,
  outstandingAtRecovery,
  onClose,
}: {
  caseId: string;
  outstandingAtRecovery: number;
  onClose: () => void;
}) {
  const advance = useAdvanceRepossession();
  const toast = useToast();
  const [auctionMethod, setAuctionMethod] = useState<"PUBLIC" | "DEALER">(
    "PUBLIC",
  );
  const [proceeds, setProceeds] = useState(0);

  const deficiency = Math.max(0, outstandingAtRecovery - proceeds);
  const surplus = Math.max(0, proceeds - outstandingAtRecovery);

  const onSubmit = async () => {
    if (proceeds < 0) {
      toast.error("Proceeds must be non-negative");
      return;
    }
    try {
      const r = await advance.mutateAsync({
        id: caseId,
        action: "auction",
        body: { auctionMethod, auctionProceeds: proceeds },
      });
      const result = r as {
        case: unknown;
        deficiency: number;
        surplus: number;
        journalEntryId: string;
      };
      toast.success(
        result.deficiency > 0
          ? `Auction posted · Deficiency ${formatMoney(result.deficiency)} written off`
          : result.surplus > 0
            ? `Auction posted · Surplus ${formatMoney(result.surplus)} to be refunded`
            : "Auction posted · loan settled in full",
      );
      onClose();
    } catch (err) {
      toast.error((err as Error).message ?? "Auction failed");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Auction settlement</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-white/55">
            Posts the auction proceeds against the loan + writes off any
            deficiency to bad debt. Closes the case and the loan.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Auction method</Label>
              <Select
                value={auctionMethod}
                onValueChange={(v) =>
                  setAuctionMethod(v as "PUBLIC" | "DEALER")
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="PUBLIC">Public auction</SelectItem>
                  <SelectItem value="DEALER">Dealer sale</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Auction proceeds (₱)</Label>
              <Input
                type="number"
                step="0.01"
                min={0}
                value={proceeds || ""}
                onChange={(e) => setProceeds(Number(e.target.value))}
              />
            </div>
          </div>
          <div className="rounded-md border border-white/10 bg-white/[0.03] p-2.5 text-xs space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-white/55">Outstanding at recovery</span>
              <span className="font-mono">
                {formatMoney(outstandingAtRecovery)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-white/55">Proceeds</span>
              <span className="font-mono">{formatMoney(proceeds)}</span>
            </div>
            {deficiency > 0 && (
              <div className="flex items-center justify-between text-rose-300">
                <span>Deficiency (→ bad debt)</span>
                <span className="font-mono">{formatMoney(deficiency)}</span>
              </div>
            )}
            {surplus > 0 && (
              <div className="flex items-center justify-between text-emerald-300">
                <span>Surplus (→ other income)</span>
                <span className="font-mono">{formatMoney(surplus)}</span>
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={advance.isPending}>
            {advance.isPending ? "Posting…" : "Post auction"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
