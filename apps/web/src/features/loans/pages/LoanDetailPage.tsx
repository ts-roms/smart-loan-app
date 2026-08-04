import type {
  CollectionNoteType,
  KycValidationResult,
  PromiseStatus,
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
import { formatDate, formatMoney } from "@loan/shared-utils";
import {
  AlertTriangle,
  Copy,
  CreditCard,
  Download,
  ExternalLink,
  FileText,
  Link2,
  MessageSquare,
  Pen,
  Phone,
  Receipt,
  RefreshCw,
  Send,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { useCrumbTitle } from "../../../providers/breadcrumb-titles";

import { SignaturePad } from "../../../components/SignaturePad";
import { downloadPdf } from "../../../lib/download-pdf";
import { useAuth } from "../../../providers/auth";
import { LoanStatusBadge } from "../components/StatusBadge";
import { PenaltyPanel } from "../components/PenaltyPanel";
import { AnnualDocsPanel } from "../components/AnnualDocsPanel";
import { ApprovalChainPanel } from "../components/ApprovalChainPanel";
import { FaceMatchPanel } from "../components/FaceMatchPanel";
import { LeasePanel } from "../components/LeasePanel";
import { LoanLedgerPanel } from "../components/LoanLedgerPanel";
import { DOC_LABELS, TYPE_LABELS } from "../constants";
import { LoanMessagePanel } from "../../messaging";
import { AssistantPanel, useExplainDecision } from "../../assistant";
import {
  useActiveDelegations,
  useAddNote,
  useCloseEarlyLoan,
  useCreatePaymentIntent,
  useCreatePromise,
  useDecideLoan,
  useDisburseLoan,
  useLoan,
  useLoanKycStatus,
  useLoanNotes,
  useLoanProducts,
  useLoanPromises,
  useMySignature,
  usePaymentIntent,
  useRecordPayment,
  useResolvePromise,
  useRestructureLoan,
  useSignAsBorrower,
  useSignAsOfficer,
  useUpload,
  useWriteOffLoan,
} from "../hooks";

/**
 * Loan detail page. Shows the application, lets an officer decide /
 * disburse, and accountants record payments against it. Owns the long
 * tail of in-context flows: close-early, restructure, write-off, online
 * payment intents, e-signature capture, and the collections panel.
 *
 * These sub-flows live as private components below — split them into
 * their own files under `../components/` only once they become big
 * enough that scrolling here is painful, or once another page needs them.
 */
export function LoanDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const loan = useLoan(id);
  const kycStatus = useLoanKycStatus(id);
  const { user } = useAuth();
  const decide = useDecideLoan();
  const disburse = useDisburseLoan();
  const recordPayment = useRecordPayment();
  const toast = useToast();
  const confirm = useConfirm();
  const askPrompt = usePrompt();
  const [paymentAmount, setPaymentAmount] = useState<number>(0);
  const [paymentRef, setPaymentRef] = useState("");

  // Breadcrumb label. Must run before the early returns below — it's a
  // hook, and bailing first would change the hook order between renders.
  useCrumbTitle(loan.data?.number ?? null);

  if (loan.isLoading) return <SkeletonCard />;
  if (!loan.data)
    return <p className="text-sm text-fg-muted">Loan not found.</p>;
  const l = loan.data;

  const canDecide = user?.role === "ADMIN" || user?.role === "LOAN_OFFICER";
  const canDisburse = canDecide && l.status === "APPROVED";
  const canPay = ["DISBURSED", "ACTIVE"].includes(l.status);
  const kycComplete = kycStatus.data?.complete === true;
  const decisionPending =
    l.status === "SUBMITTED" || l.status === "UNDER_REVIEW";

  const onDecide = async (
    status: "APPROVED" | "REJECTED",
    overrideKyc = false,
  ) => {
    let reason: string | undefined;
    if (status === "REJECTED") {
      const answer = await askPrompt({
        title: "Reject this loan?",
        message:
          "The rejection reason is shared with the customer and recorded in the audit log.",
        label: "Reason",
        placeholder: "e.g. insufficient income, missing documents",
        confirmLabel: "Reject",
      });
      if (answer === null) return; // cancelled
      reason = answer;
    }
    try {
      await decide.mutateAsync({ id: l.id, status, reason, overrideKyc });
      toast.success(`Loan ${status.toLowerCase()}`);
    } catch (err) {
      toast.error((err as Error).message ?? "Failed");
    }
  };

  const onApprove = async () => {
    if (!kycComplete) {
      const ok = await confirm({
        title: "KYC not complete — approve anyway?",
        message: "The override will be recorded in the audit trail.",
        confirmLabel: "Override and approve",
        tone: "destructive",
      });
      if (!ok) return;
      await onDecide("APPROVED", true);
    } else {
      await onDecide("APPROVED");
    }
  };

  const onDisburse = async () => {
    try {
      await disburse.mutateAsync(l.id);
      toast.success("Loan disbursed");
    } catch (err) {
      toast.error((err as Error).message ?? "Failed");
    }
  };

  const onRecord = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await recordPayment.mutateAsync({
        loanId: l.id,
        amount: paymentAmount,
        reference: paymentRef || undefined,
      });
      toast.success("Payment recorded");
      setPaymentAmount(0);
      setPaymentRef("");
    } catch (err) {
      toast.error((err as Error).message ?? "Failed");
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <CardTitle className="flex items-center gap-2 font-mono">
          <CreditCard className="h-4 w-4" />
          {l.number}
        </CardTitle>
        <div className="flex items-center gap-2">
          <Badge variant="muted">
            {TYPE_LABELS[l.productCode] ?? l.productCode}
          </Badge>
          <LoanStatusBadge status={l.status} />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <Info label="Product">
            {TYPE_LABELS[l.productCode] ?? l.productCode}
          </Info>
          <Info label="Principal">{formatMoney(Number(l.principal))}</Info>
          <Info label="Term">{l.termMonths} months</Info>
          <Info label="APR">
            {(Number(l.annualInterestRate) * 100).toFixed(2)}%
          </Info>
          <Info label="Submitted">{formatDate(l.submittedAt)}</Info>
          <Info label="Tier @ apply">{l.tierAtApply ?? "—"}</Info>
          <Info label="Score @ apply">{l.creditScoreAtApply ?? "—"}</Info>
          <Info label="Decided">{formatDate(l.decidedAt)}</Info>
        </div>
        {l.vehicle && <CollateralPanel kind="VEHICLE" v={l.vehicle} />}
        {l.property && <CollateralPanel kind="PROPERTY" p={l.property} />}
        {l.applicationSelfieUrl && (
          <div className="rounded-md border border-default bg-surface-2 p-3">
            <div className="text-xs uppercase tracking-wider text-fg-subtle mb-2">
              Application selfie
            </div>
            <a
              href={l.applicationSelfieUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <img
                src={l.applicationSelfieUrl}
                alt="application selfie"
                className="h-32 rounded-md border border-default object-cover"
              />
            </a>
          </div>
        )}
        {/*
          Approval chain — only renders when this loan's product has one
          configured (`currentApprovalStep != null` and rows exist). For
          products without a chain, the legacy single-decide buttons in
          DecisionPanel handle approval.
        */}
        <ApprovalChainPanel loan={l} />
        {/*
          Face-match panel: compares selfie ↔ ID locally via face-api.js.
          Hidden when there's no selfie or no VERIFIED ID_FRONT — nothing
          to compare. Officer clicks "Run face match" to compute; result
          is persisted on the loan + audit-logged.
        */}
        <FaceMatchPanel loan={l} />
        {/*
          AI assistant — explain the loan's decisioning verdict in plain
          language. Local LLM only; never sends data off-server. Officer
          reviews + edits before doing anything with the output.
        */}
        <LoanAssistantPanel loanId={l.id} />
        {l.purpose && (
          <div className="text-sm">
            <span className="text-fg-muted">Purpose: </span>
            {l.purpose}
          </div>
        )}
        {l.decisionReason && (
          <div className="text-sm text-danger">
            <span className="text-fg-muted">Reason: </span>
            {l.decisionReason}
          </div>
        )}

        <DocumentsPanel loanId={l.id} loanNumber={l.number} status={l.status} />
        {![
          "DRAFT",
          "SUBMITTED",
          "UNDER_REVIEW",
          "REJECTED",
          "CANCELLED",
        ].includes(l.status) && (
          <SignaturesPanel
            loanId={l.id}
            borrowerSignatureUrl={l.borrowerSignatureUrl}
            borrowerSignedAt={l.borrowerSignedAt}
            officerSignatureUrl={l.officerSignatureUrl}
            officerSignedAt={l.officerSignedAt}
          />
        )}
        <LeasePanel loanId={l.id} />
        <PenaltyPanel loanId={l.id} />
        <AnnualDocsPanel loanId={l.id} />
        {/* Schedule before payments: what was owed reads first, what
            came in reads against it. The panel self-hides when there is
            no schedule, i.e. before disbursement. */}
        <LoanLedgerPanel rows={l.schedule ?? []} principal={l.principal} />
        {l.payments && l.payments.length > 0 && (
          <PaymentsPanel loanId={l.id} payments={l.payments} />
        )}

        {/* Officer ↔ borrower thread. Lives below the operational
            panels so the conversation is easy to find but doesn't
            dominate the decisioning surface. */}
        {!["DRAFT"].includes(l.status) && (
          <LoanMessagePanel loanId={l.id} perspective="OFFICER" />
        )}

        {decisionPending && kycStatus.data && (
          <KycChecklist status={kycStatus.data} />
        )}

        {canDecide && decisionPending && (
          <div className="flex gap-2 border-t border-default pt-3">
            <Button onClick={onApprove} disabled={decide.isPending}>
              {kycComplete ? "Approve" : "Approve (override KYC)"}
            </Button>
            <Button
              variant="outline"
              onClick={() => onDecide("REJECTED")}
              disabled={decide.isPending}
            >
              Reject
            </Button>
          </div>
        )}
        {canDisburse && (
          <div className="border-t border-default pt-3">
            <Button onClick={onDisburse} disabled={disburse.isPending}>
              {disburse.isPending ? "Disbursing…" : "Disburse funds"}
            </Button>
          </div>
        )}

        {["ACTIVE", "DISBURSED"].includes(l.status) && canDecide && (
          <div className="border-t border-default pt-3 flex flex-wrap gap-2">
            <CloseEarlyButton loanId={l.id} />
            <RestructureButton
              loanId={l.id}
              currentProductCode={l.productCode}
            />
            <WriteOffButton loanId={l.id} />
          </div>
        )}

        {canPay && (
          <div className="border-t border-default pt-3 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-xs uppercase tracking-wider text-fg-muted">
                Record payment
              </div>
              <PayOnlineButton loanId={l.id} />
            </div>
            <form onSubmit={onRecord} className="space-y-2">
              <div className="grid grid-cols-3 gap-2">
                <Input
                  type="number"
                  min={1}
                  placeholder="Amount"
                  value={paymentAmount || ""}
                  onChange={(e) => setPaymentAmount(Number(e.target.value))}
                  required
                />
                <Input
                  placeholder="Reference / OR #"
                  value={paymentRef}
                  onChange={(e) => setPaymentRef(e.target.value)}
                />
                <Button
                  type="submit"
                  disabled={recordPayment.isPending || paymentAmount <= 0}
                >
                  {recordPayment.isPending ? "Saving…" : "Record"}
                </Button>
              </div>
            </form>
          </div>
        )}

        {["ACTIVE", "DISBURSED", "DEFAULTED"].includes(l.status) && (
          <CollectionsPanel loanId={l.id} />
        )}
      </CardContent>
    </Card>
  );
}

// ── Private helpers ────────────────────────────────────────────────────────
// These render only inside LoanDetailPage. Promote to ../components/ when
// (a) another page needs them or (b) the scroll cost makes this file painful.

function Info({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-fg-subtle">
        {label}
      </div>
      <div className="text-sm">{children ?? "—"}</div>
    </div>
  );
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

function KycChecklist({ status }: { status: KycValidationResult }) {
  const isComplete = status.complete;
  return (
    <div
      className={`rounded-md border p-3 ${
        isComplete
          ? "border-emerald-400/20 bg-emerald-500/5"
          : "border-amber-400/20 bg-amber-500/5"
      }`}
    >
      <div className="text-xs uppercase tracking-wider text-fg-muted mb-2 flex items-center justify-between">
        <span>KYC requirements for this loan</span>
        <Badge variant={isComplete ? "success" : "warning"}>
          {status.status}
        </Badge>
      </div>
      {status.missing.length === 0 && status.rejected.length === 0 ? (
        <div className="text-sm text-success">
          All required documents verified.
        </div>
      ) : (
        <ul className="space-y-1 text-sm">
          {status.rejected.map((d) => (
            <li key={`r-${d}`} className="flex items-center gap-2">
              <span className="text-danger">✗</span>
              <span>{DOC_LABELS[d]} — rejected</span>
            </li>
          ))}
          {status.missing.map((d) => (
            <li key={`m-${d}`} className="flex items-center gap-2">
              <span className="text-warning">○</span>
              <span>{DOC_LABELS[d]} — missing</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface VehicleData {
  kind: string;
  make: string;
  model: string;
  year: number;
  plateNumber?: string | null;
  chassisNumber?: string | null;
  engineNumber?: string | null;
  color?: string | null;
  appraisedValue: string | number;
  status: string;
}
interface PropertyData {
  propertyType: string;
  address: string;
  city: string;
  province?: string | null;
  titleNumber?: string | null;
  taxDecNumber?: string | null;
  areaSqm?: string | number | null;
  appraisedValue: string | number;
  status: string;
}

function CollateralPanel(
  props:
    { kind: "VEHICLE"; v: VehicleData } | { kind: "PROPERTY"; p: PropertyData },
) {
  return (
    <div className="rounded-md border border-default bg-surface-2 p-3">
      <div className="text-xs uppercase tracking-wider text-fg-subtle mb-2 flex items-center justify-between">
        <span>
          {props.kind === "VEHICLE"
            ? "Vehicle collateral"
            : "Property collateral"}
        </span>
        <Badge variant="muted">
          {props.kind === "VEHICLE" ? props.v.status : props.p.status}
        </Badge>
      </div>
      {props.kind === "VEHICLE" ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <Info label="Make">{props.v.make}</Info>
          <Info label="Model">{props.v.model}</Info>
          <Info label="Year">{props.v.year}</Info>
          <Info label="Appraised">
            {formatMoney(Number(props.v.appraisedValue))}
          </Info>
          <Info label="Plate">{props.v.plateNumber ?? "—"}</Info>
          <Info label="Chassis">{props.v.chassisNumber ?? "—"}</Info>
          <Info label="Engine">{props.v.engineNumber ?? "—"}</Info>
          <Info label="Color">{props.v.color ?? "—"}</Info>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <Info label="Type">{props.p.propertyType}</Info>
          <Info label="Title #">{props.p.titleNumber ?? "—"}</Info>
          <Info label="Tax dec #">{props.p.taxDecNumber ?? "—"}</Info>
          <Info label="Appraised">
            {formatMoney(Number(props.p.appraisedValue))}
          </Info>
          <div className="col-span-2">
            <Info label="Address">
              {props.p.address}, {props.p.city}
              {props.p.province ? `, ${props.p.province}` : ""}
            </Info>
          </div>
          <Info label="Area">
            {props.p.areaSqm ? `${Number(props.p.areaSqm)} sqm` : "—"}
          </Info>
        </div>
      )}
    </div>
  );
}

function CloseEarlyButton({ loanId }: { loanId: string }) {
  const closeEarly = useCloseEarlyLoan();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(0);
  const [reference, setReference] = useState("");
  const [result, setResult] = useState<{
    remainingPrincipal: number;
    fee: number;
    totalSettled: number;
  } | null>(null);

  const onConfirm = async () => {
    if (amount <= 0) return;
    try {
      const r = await closeEarly.mutateAsync({
        id: loanId,
        settlementAmount: amount,
        reference: reference || undefined,
      });
      setResult({
        remainingPrincipal: r.remainingPrincipal,
        fee: r.fee,
        totalSettled: r.totalSettled,
      });
      toast.success("Loan closed early");
    } catch (err) {
      toast.error((err as Error).message ?? "Failed to close");
    }
  };

  const reset = () => {
    setOpen(false);
    setAmount(0);
    setReference("");
    setResult(null);
  };

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Close loan early
      </Button>
      {open && (
        <Dialog open onOpenChange={(o) => !o && reset()}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Early settlement</DialogTitle>
            </DialogHeader>
            {result ? (
              <div className="space-y-2 text-sm">
                <Info label="Remaining principal">
                  {formatMoney(result.remainingPrincipal)}
                </Info>
                <Info label="Pre-termination fee">
                  {formatMoney(result.fee)}
                </Info>
                <Info label="Total settled">
                  {formatMoney(result.totalSettled)}
                </Info>
                <DialogFooter>
                  <Button onClick={reset}>Done</Button>
                </DialogFooter>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-fg-muted">
                  The system computes the remaining principal + the product's
                  pre-termination fee. Enter the settlement amount the customer
                  is paying.
                </p>
                <Input
                  type="number"
                  min={1}
                  placeholder="Settlement amount (₱)"
                  value={amount || ""}
                  onChange={(e) => setAmount(Number(e.target.value))}
                />
                <Input
                  placeholder="Reference (optional)"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                />
                <DialogFooter>
                  <Button variant="outline" onClick={reset}>
                    Cancel
                  </Button>
                  <Button
                    onClick={onConfirm}
                    disabled={closeEarly.isPending || amount <= 0}
                  >
                    {closeEarly.isPending ? "Settling…" : "Settle"}
                  </Button>
                </DialogFooter>
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

function RestructureButton({
  loanId,
  currentProductCode,
}: {
  loanId: string;
  currentProductCode: string;
}) {
  const restructure = useRestructureLoan();
  const products = useLoanProducts();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [productCode, setProductCode] = useState(currentProductCode);
  const [principal, setPrincipal] = useState(0);
  const [termMonths, setTermMonths] = useState(12);
  const [ratePercent, setRatePercent] = useState(18);
  const [purpose, setPurpose] = useState("");

  const onSubmit = async () => {
    if (principal <= 0) return;
    try {
      const r = await restructure.mutateAsync({
        id: loanId,
        productCode,
        principal,
        termMonths,
        annualInterestRate: ratePercent / 100,
        purpose: purpose || undefined,
      });
      toast.success(`Restructured → ${r.replacement.number}`);
      setOpen(false);
    } catch (err) {
      toast.error((err as Error).message ?? "Failed");
    }
  };

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <RefreshCw className="h-3 w-3" />
        Restructure
      </Button>
      {open && (
        <Dialog open onOpenChange={(o) => !o && setOpen(false)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Restructure loan</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <p className="text-sm text-fg-muted">
                The original loan is marked RESTRUCTURED and a new loan replaces
                it. If new principal &gt; remaining, the difference is disbursed
                as a top-up; if smaller, the gap is booked as a partial
                write-down.
              </p>
              <Field label="Product">
                <Select value={productCode} onValueChange={setProductCode}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(products.data ?? [])
                      .filter((p) => p.active)
                      .map((p) => (
                        <SelectItem key={p.id} value={p.code}>
                          {p.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </Field>
              <div className="grid grid-cols-3 gap-2">
                <Field label="New principal (₱)">
                  <Input
                    type="number"
                    min={1}
                    value={principal || ""}
                    onChange={(e) => setPrincipal(Number(e.target.value))}
                  />
                </Field>
                <Field label="Term (months)">
                  <Input
                    type="number"
                    min={1}
                    value={termMonths}
                    onChange={(e) => setTermMonths(Number(e.target.value))}
                  />
                </Field>
                <Field label="APR (%)">
                  <Input
                    type="number"
                    min={0}
                    step={0.25}
                    value={ratePercent}
                    onChange={(e) => setRatePercent(Number(e.target.value))}
                  />
                </Field>
              </div>
              <Field label="Purpose / reason">
                <Input
                  value={purpose}
                  onChange={(e) => setPurpose(e.target.value)}
                  placeholder="Customer's request for extension"
                />
              </Field>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={onSubmit}
                  disabled={restructure.isPending || principal <= 0}
                >
                  {restructure.isPending ? "Restructuring…" : "Restructure"}
                </Button>
              </DialogFooter>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

function WriteOffButton({ loanId }: { loanId: string }) {
  const writeOff = useWriteOffLoan();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  const onSubmit = async () => {
    if (!reason.trim()) return;
    try {
      const r = await writeOff.mutateAsync({ id: loanId, reason });
      toast.success(`Wrote off ${formatMoney(r.amount)} as Bad Debt`);
      setOpen(false);
      setReason("");
    } catch (err) {
      toast.error((err as Error).message ?? "Failed");
    }
  };

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <AlertTriangle className="h-3 w-3" />
        Write off
      </Button>
      {open && (
        <Dialog open onOpenChange={(o) => !o && setOpen(false)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Write off loan</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div className="rounded-md border border-rose-400/30 bg-rose-500/5 p-3 text-sm">
                <strong className="text-danger">Terminal action.</strong> The
                remaining principal is posted as Bad Debt Expense and the loan
                is closed. Cannot be undone (only reversed via a journal entry).
              </div>
              <Field label="Reason">
                <Input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Borrower deceased, fraud confirmed"
                  required
                />
              </Field>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={onSubmit}
                  disabled={writeOff.isPending || !reason.trim()}
                >
                  {writeOff.isPending ? "Writing off…" : "Confirm write-off"}
                </Button>
              </DialogFooter>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

function PayOnlineButton({ loanId }: { loanId: string }) {
  const create = useCreatePaymentIntent();
  const toast = useToast();
  const [amount, setAmount] = useState(0);
  const [intentId, setIntentId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // While the dialog is open and the intent is not yet PAID, poll every 3s.
  const intent = usePaymentIntent(intentId, {
    refetchInterval: intentId ? 3000 : undefined,
  });

  const onCreate = async () => {
    if (amount <= 0) return;
    try {
      const created = await create.mutateAsync({ loanId, amount });
      setIntentId(created.id);
    } catch (err) {
      toast.error((err as Error).message ?? "Failed");
    }
  };

  const copyLink = async () => {
    if (!intent.data?.paymentUrl) return;
    try {
      await navigator.clipboard.writeText(intent.data.paymentUrl);
      toast.success("Link copied");
    } catch {
      toast.error("Copy failed");
    }
  };

  const reset = () => {
    setOpen(false);
    setIntentId(null);
    setAmount(0);
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Link2 className="h-3 w-3" />
        Pay online
      </Button>
      {open && (
        <Dialog open onOpenChange={(o) => !o && reset()}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Online payment</DialogTitle>
            </DialogHeader>
            {!intentId ? (
              <div className="space-y-3">
                <p className="text-sm text-fg-muted">
                  Generate a payment link. Customer opens the link, pays via the
                  provider, and the loan payment is posted automatically when
                  the webhook fires.
                </p>
                <Input
                  type="number"
                  min={1}
                  placeholder="Amount (₱)"
                  value={amount || ""}
                  onChange={(e) => setAmount(Number(e.target.value))}
                />
                <DialogFooter>
                  <Button variant="outline" onClick={reset}>
                    Cancel
                  </Button>
                  <Button
                    onClick={onCreate}
                    disabled={create.isPending || amount <= 0}
                  >
                    {create.isPending ? "Generating…" : "Generate link"}
                  </Button>
                </DialogFooter>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-fg-muted">Status</span>
                  <Badge
                    variant={
                      intent.data?.status === "PAID" ? "success" : "warning"
                    }
                  >
                    {intent.data?.status ?? "CREATED"}
                  </Badge>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-fg-muted">Payment URL</label>
                  <div className="flex gap-2">
                    <Input value={intent.data?.paymentUrl ?? ""} readOnly />
                    <Button variant="outline" size="sm" onClick={copyLink}>
                      <Copy className="h-3 w-3" />
                    </Button>
                    <a
                      href={intent.data?.paymentUrl ?? "#"}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center justify-center h-9 px-2 rounded-md border border-default hover:bg-hover"
                    >
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                  <p className="text-xs text-fg-subtle">
                    Sandbox: opening the URL marks the intent PAID and
                    auto-posts the payment.
                  </p>
                </div>
                <DialogFooter>
                  <Button onClick={reset}>
                    {intent.data?.status === "PAID" ? "Done" : "Close"}
                  </Button>
                </DialogFooter>
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

function CollectionsPanel({ loanId }: { loanId: string }) {
  const notes = useLoanNotes(loanId);
  const promises = useLoanPromises(loanId);
  const addNote = useAddNote();
  const createPromise = useCreatePromise();
  const resolve = useResolvePromise();
  const toast = useToast();

  const [noteBody, setNoteBody] = useState("");
  const [noteType, setNoteType] = useState<CollectionNoteType>("CALL");
  const [ptpAmount, setPtpAmount] = useState(0);
  const [ptpDate, setPtpDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toISOString().slice(0, 10);
  });
  const [ptpNote, setPtpNote] = useState("");

  const onAddNote = async (e: FormEvent) => {
    e.preventDefault();
    if (!noteBody.trim()) return;
    try {
      await addNote.mutateAsync({ loanId, type: noteType, body: noteBody });
      toast.success("Note added");
      setNoteBody("");
    } catch (err) {
      toast.error((err as Error).message ?? "Failed");
    }
  };

  const onCreatePtp = async (e: FormEvent) => {
    e.preventDefault();
    if (ptpAmount <= 0) return;
    try {
      await createPromise.mutateAsync({
        loanId,
        amount: ptpAmount,
        promisedDate: ptpDate,
        note: ptpNote || undefined,
      });
      toast.success("Promise recorded");
      setPtpAmount(0);
      setPtpNote("");
    } catch (err) {
      toast.error((err as Error).message ?? "Failed");
    }
  };

  const onResolve = async (id: string, status: PromiseStatus) => {
    try {
      await resolve.mutateAsync({ id, loanId, status });
      toast.success(`Marked ${status.toLowerCase()}`);
    } catch (err) {
      toast.error((err as Error).message ?? "Failed");
    }
  };

  return (
    <div className="border-t border-default pt-3 space-y-4">
      <div className="text-xs uppercase tracking-wider text-fg-muted flex items-center gap-1">
        <Phone className="h-3 w-3" />
        Collections
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Notes */}
        <div className="space-y-2">
          <div className="text-xs text-fg-muted">Activity log</div>
          <form onSubmit={onAddNote} className="space-y-2">
            <div className="flex gap-2">
              <Select
                value={noteType}
                onValueChange={(v) => setNoteType(v as CollectionNoteType)}
              >
                <SelectTrigger className="h-9 w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="CALL">Call</SelectItem>
                  <SelectItem value="SMS">SMS</SelectItem>
                  <SelectItem value="EMAIL">Email</SelectItem>
                  <SelectItem value="VISIT">Visit</SelectItem>
                  <SelectItem value="OTHER">Other</SelectItem>
                </SelectContent>
              </Select>
              <Input
                placeholder="What did you discuss?"
                value={noteBody}
                onChange={(e) => setNoteBody(e.target.value)}
              />
              <Button
                type="submit"
                size="sm"
                disabled={addNote.isPending || !noteBody.trim()}
              >
                <Send className="h-3 w-3" />
              </Button>
            </div>
          </form>
          {notes.isLoading ? (
            <p className="text-xs text-fg-subtle">Loading…</p>
          ) : (notes.data ?? []).length === 0 ? (
            <p className="text-xs text-fg-subtle">No notes yet.</p>
          ) : (
            <ul className="space-y-1 max-h-48 overflow-auto pr-1">
              {(notes.data ?? []).map((n) => (
                <li
                  key={n.id}
                  className="rounded-md border border-default bg-surface-2 p-2 text-xs"
                >
                  <div className="flex items-center justify-between text-fg-subtle">
                    <Badge variant="muted">{n.type}</Badge>
                    <span>{formatDate(n.createdAt)}</span>
                  </div>
                  <div className="mt-1">{n.body}</div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Promises to pay */}
        <div className="space-y-2">
          <div className="text-xs text-fg-muted flex items-center gap-1">
            <MessageSquare className="h-3 w-3" />
            Promises to pay
          </div>
          <form onSubmit={onCreatePtp} className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <Input
                type="number"
                placeholder="Amount"
                min={1}
                value={ptpAmount || ""}
                onChange={(e) => setPtpAmount(Number(e.target.value))}
              />
              <DatePicker
                value={ptpDate}
                onChange={setPtpDate}
                min={new Date().toISOString().slice(0, 10)}
                placeholder="Promise date"
              />
            </div>
            <Input
              placeholder="Note (optional)"
              value={ptpNote}
              onChange={(e) => setPtpNote(e.target.value)}
            />
            <Button
              type="submit"
              size="sm"
              className="w-full"
              disabled={createPromise.isPending || ptpAmount <= 0}
            >
              {createPromise.isPending ? "Recording…" : "Record promise"}
            </Button>
          </form>
          {promises.isLoading ? (
            <p className="text-xs text-fg-subtle">Loading…</p>
          ) : (promises.data ?? []).length === 0 ? (
            <p className="text-xs text-fg-subtle">No promises yet.</p>
          ) : (
            <ul className="space-y-1 max-h-48 overflow-auto pr-1">
              {(promises.data ?? []).map((p) => (
                <li
                  key={p.id}
                  className="rounded-md border border-default bg-surface-2 p-2 text-xs space-y-1"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="font-mono">
                        {formatMoney(Number(p.amount))}
                      </span>{" "}
                      <span className="text-fg-subtle">
                        by {formatDate(p.promisedDate)}
                      </span>
                    </div>
                    <Badge variant={ptpVariant(p.status)}>{p.status}</Badge>
                  </div>
                  {p.note && <div className="text-fg-muted">{p.note}</div>}
                  {p.status === "PROMISED" && (
                    <div className="flex gap-1 pt-1">
                      <button
                        type="button"
                        className="text-success hover:underline"
                        onClick={() => onResolve(p.id, "HONORED")}
                      >
                        Honored
                      </button>
                      <span className="text-fg-subtle">·</span>
                      <button
                        type="button"
                        className="text-danger hover:underline"
                        onClick={() => onResolve(p.id, "BROKEN")}
                      >
                        Broken
                      </button>
                      <span className="text-fg-subtle">·</span>
                      <button
                        type="button"
                        className="text-fg-muted hover:underline"
                        onClick={() => onResolve(p.id, "CANCELLED")}
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function ptpVariant(
  status: PromiseStatus,
): "success" | "danger" | "muted" | "warning" {
  switch (status) {
    case "HONORED":
      return "success";
    case "BROKEN":
      return "danger";
    case "CANCELLED":
      return "muted";
    case "PROMISED":
      return "warning";
    default:
      return "muted";
  }
}

function DocumentsPanel({
  loanId,
  loanNumber,
  status,
}: {
  loanId: string;
  loanNumber: string;
  status: string;
}) {
  const toast = useToast();
  // Every hook must run before the early return below. `status` changes
  // under this component while the page is open (an officer approves the
  // loan in another tab, the query refetches), which flips the guard from
  // "return null" to "render" — and if a hook sat after the return, that
  // transition would change the hook count between renders and React
  // would throw "Rendered more hooks than during the previous render".
  const mySig = useMySignature();
  const hasSig = Boolean(mySig.data?.signatureUrl);

  // Agreement only makes sense once the customer has accepted terms — i.e.
  // post-APPROVED. Statement is available any time once schedule exists.
  const showAgreement = ![
    "DRAFT",
    "SUBMITTED",
    "UNDER_REVIEW",
    "REJECTED",
    "CANCELLED",
  ].includes(status);
  const showStatement = !["DRAFT", "SUBMITTED", "UNDER_REVIEW"].includes(
    status,
  );
  if (!showAgreement && !showStatement) return null;

  const download = async (kind: "agreement" | "statement", signed = false) => {
    try {
      const qs = signed ? "?sign=1" : "";
      const suffix = signed ? "-signed" : "";
      await downloadPdf(
        `/loans/${loanId}/${kind}.pdf${qs}`,
        `${kind}-${loanNumber}${suffix}.pdf`,
      );
    } catch (err) {
      toast.error((err as Error).message ?? "Download failed");
    }
  };

  return (
    <div className="border-t border-default pt-3">
      <div className="text-xs uppercase tracking-wider text-fg-muted mb-2 flex items-center gap-1">
        <FileText className="h-3 w-3" />
        Documents
      </div>
      <div className="flex flex-wrap gap-2">
        {showAgreement && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => download("agreement")}
            >
              <Download className="h-3 w-3" />
              Loan agreement
            </Button>
            {hasSig && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => download("agreement", true)}
                title="Embed your saved personnel signature as Prepared by"
              >
                <Pen className="h-3 w-3" />
                Agreement (with my signature)
              </Button>
            )}
          </>
        )}
        {showStatement && (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => download("statement")}
            >
              <Download className="h-3 w-3" />
              Statement of account
            </Button>
            {hasSig && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => download("statement", true)}
                title="Embed your saved personnel signature as Prepared by"
              >
                <Pen className="h-3 w-3" />
                Statement (with my signature)
              </Button>
            )}
          </>
        )}
      </div>
      {!hasSig && (showAgreement || showStatement) && (
        <p className="text-[10px] text-fg-subtle mt-2">
          Tip: save a signature in{" "}
          <a className="underline" href="/settings">
            My settings
          </a>{" "}
          to enable signed downloads.
        </p>
      )}
    </div>
  );
}

interface PaymentRow {
  id: string;
  amount: string | number;
  paidOn: string | Date;
  reference: string | null;
}

function PaymentsPanel({
  loanId,
  payments,
}: {
  loanId: string;
  payments: PaymentRow[];
}) {
  const toast = useToast();
  const mySig = useMySignature();
  const hasSig = Boolean(mySig.data?.signatureUrl);
  const onReceipt = async (paymentId: string, signed = false) => {
    try {
      const qs = signed ? "?sign=1" : "";
      const suffix = signed ? "-signed" : "";
      await downloadPdf(
        `/loans/${loanId}/payments/${paymentId}/receipt.pdf${qs}`,
        `receipt-${paymentId.slice(0, 8)}${suffix}.pdf`,
      );
    } catch (err) {
      toast.error((err as Error).message ?? "Download failed");
    }
  };
  return (
    <div className="border-t border-default pt-3">
      <div className="text-xs uppercase tracking-wider text-fg-muted mb-2 flex items-center gap-1">
        <Receipt className="h-3 w-3" />
        Payments ({payments.length})
      </div>
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wider text-fg-subtle">
          <tr>
            <th className="py-1 px-2">Paid on</th>
            <th className="py-1 px-2">OR #</th>
            <th className="py-1 px-2">Reference</th>
            <th className="py-1 px-2 text-right">Amount</th>
            <th />
          </tr>
        </thead>
        <tbody className="divide-y divide-default">
          {payments.map((p) => (
            <tr key={p.id} className="hover:bg-hover">
              <td className="py-1.5 px-2 text-xs">{formatDate(p.paidOn)}</td>
              <td className="py-1.5 px-2 font-mono text-xs">
                {p.id.slice(0, 8).toUpperCase()}
              </td>
              <td className="py-1.5 px-2 text-xs text-fg-muted">
                {p.reference ?? "—"}
              </td>
              <td className="py-1.5 px-2 text-right font-mono">
                {formatMoney(Number(p.amount))}
              </td>
              <td className="py-1.5 px-2 text-right">
                <div className="inline-flex gap-1">
                  <button
                    type="button"
                    onClick={() => onReceipt(p.id)}
                    className="text-fg-muted hover:text-info"
                    title="Download receipt"
                  >
                    <Download className="h-3 w-3" />
                  </button>
                  {hasSig && (
                    <button
                      type="button"
                      onClick={() => onReceipt(p.id, true)}
                      className="text-fg-muted hover:text-info"
                      title="Download with my signature"
                    >
                      <Pen className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SignaturesPanel({
  loanId,
  borrowerSignatureUrl,
  borrowerSignedAt,
  officerSignatureUrl,
  officerSignedAt,
}: {
  loanId: string;
  borrowerSignatureUrl: string | null;
  borrowerSignedAt: string | null;
  officerSignatureUrl: string | null;
  officerSignedAt: string | null;
}) {
  const [openPad, setOpenPad] = useState<"borrower" | "officer" | null>(null);
  const [delegationId, setDelegationId] = useState<string>("");
  const upload = useUpload();
  const signOfficer = useSignAsOfficer();
  const signBorrower = useSignAsBorrower("officer");
  const toast = useToast();
  const activeDelegations = useActiveDelegations();

  // Delegations that grant loans.sign_officer (blanket or explicit).
  const eligibleDelegations = (activeDelegations.data ?? []).filter(
    (d) =>
      d.permissions.length === 0 ||
      d.permissions.includes("loans.sign_officer"),
  );

  const onSign = async (blob: Blob) => {
    if (!openPad) return;
    try {
      const file = new File([blob], `${openPad}-signature.png`, {
        type: "image/png",
      });
      const result = await upload.mutateAsync({ file, subdir: "signatures" });
      if (openPad === "officer") {
        await signOfficer.mutateAsync({
          loanId,
          signatureUrl: result.url,
          delegationId: delegationId || undefined,
        });
      } else {
        await signBorrower.mutateAsync({ loanId, signatureUrl: result.url });
      }
      toast.success(
        `${openPad === "officer" ? "Officer" : "Borrower"} signature saved`,
      );
      setOpenPad(null);
      setDelegationId("");
    } catch (err) {
      toast.error((err as Error).message ?? "Failed to sign");
    }
  };

  const submitting =
    upload.isPending || signOfficer.isPending || signBorrower.isPending;

  return (
    <div className="border-t border-default pt-3">
      <div className="text-xs uppercase tracking-wider text-fg-muted mb-2 flex items-center gap-1">
        <Pen className="h-3 w-3" />
        E-signatures
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <SignatureSlot
          label="Borrower"
          url={borrowerSignatureUrl}
          signedAt={borrowerSignedAt}
          onCapture={() => setOpenPad("borrower")}
        />
        <SignatureSlot
          label="Lender / Officer"
          url={officerSignatureUrl}
          signedAt={officerSignedAt}
          onCapture={() => setOpenPad("officer")}
        />
      </div>
      {openPad && (
        <Dialog open onOpenChange={(o) => !o && setOpenPad(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                Capture signature —{" "}
                {openPad === "officer" ? "Officer" : "Borrower"}
              </DialogTitle>
            </DialogHeader>
            {openPad === "officer" && eligibleDelegations.length > 0 && (
              <div className="mb-2 rounded-md border border-amber-400/40 bg-amber-400/10 p-2 text-xs">
                <label className="block mb-1 text-warning">
                  Sign under delegation (optional)
                </label>
                <Select
                  value={delegationId || "__none__"}
                  onValueChange={(v) =>
                    setDelegationId(v === "__none__" ? "" : v)
                  }
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">My own authority</SelectItem>
                    {eligibleDelegations.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        Proxy — delegation {d.id.slice(0, 8)} (
                        {d.permissions.length === 0
                          ? "blanket"
                          : "sign_officer"}
                        )
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="mt-1 text-[10px] text-fg-muted">
                  Pin a delegation here to record on the loan that this
                  signature was made under proxy authority.
                </p>
              </div>
            )}
            <SignaturePad
              onSubmit={onSign}
              submitting={submitting}
              label="Draw signature using mouse, stylus, or touch."
            />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function SignatureSlot({
  label,
  url,
  signedAt,
  onCapture,
}: {
  label: string;
  url: string | null;
  signedAt: string | null;
  onCapture: () => void;
}) {
  return (
    <div className="rounded-md border border-default bg-surface-2 p-3">
      <div className="text-xs uppercase tracking-wider text-fg-subtle mb-2 flex items-center justify-between">
        <span>{label}</span>
        <Badge variant={url ? "success" : "muted"}>
          {url ? "Signed" : "Not signed"}
        </Badge>
      </div>
      {url ? (
        <div className="space-y-1">
          <img
            src={url}
            alt={`${label} signature`}
            className="h-16 bg-white rounded p-1 border border-default"
          />
          {signedAt && (
            <div className="text-[10px] text-fg-subtle">
              on {formatDate(signedAt)}
            </div>
          )}
          <Button variant="outline" size="sm" onClick={onCapture}>
            <Pen className="h-3 w-3" />
            Re-sign
          </Button>
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={onCapture}>
          <Pen className="h-3 w-3" />
          Sign now
        </Button>
      )}
    </div>
  );
}

/**
 * AI assistant slot on the loan detail page. Builds one task (explain
 * decision) and feeds it to the reusable AssistantPanel. The hook is
 * called here (instead of inside AssistantPanel) so the mutation is
 * scoped to the loan id; this lets us re-mount cleanly between loans.
 */
function LoanAssistantPanel({ loanId }: { loanId: string }) {
  const explain = useExplainDecision();
  return (
    <AssistantPanel
      tasks={[
        {
          id: "explain-decision",
          label: "Explain decision",
          hint: "Generate a plain-language explanation of why the engine reached its verdict.",
          run: () => explain.mutateAsync({ loanId }),
        },
      ]}
    />
  );
}
