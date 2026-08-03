import {
  usePortalCreatePaymentIntent,
  usePortalLoan,
  usePortalPaymentIntent,
  useSignAsBorrower,
  useUpload,
} from "@loan/api-client";
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
  SkeletonCard,
  useToast,
} from "@loan/ui";
import { formatDate, formatMoney } from "@loan/shared-utils";
import {
  Copy,
  Download,
  ExternalLink,
  FileText,
  Link2,
  Pen,
} from "lucide-react";
import { useState } from "react";
import { useParams } from "react-router-dom";

import { downloadPdf } from "../../../lib/download-pdf";
import { SignaturePad } from "../../../components/SignaturePad";
import { LoanMessagePanel } from "../../messaging";

export function PortalLoanDetail() {
  const { id = "" } = useParams<{ id: string }>();
  const loan = usePortalLoan(id);

  if (loan.isLoading) return <SkeletonCard />;
  if (!loan.data)
    return <p className="text-sm text-fg-muted">Loan not found.</p>;
  const l = loan.data;
  const payable = ["DISBURSED", "ACTIVE"].includes(l.status);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="font-mono">{l.number}</CardTitle>
          <Badge variant={badgeVariant(l.status)}>{l.status}</Badge>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <Info label="Principal">{formatMoney(Number(l.principal))}</Info>
            <Info label="Term">{l.termMonths} months</Info>
            <Info label="APR">
              {(Number(l.annualInterestRate) * 100).toFixed(2)}%
            </Info>
            <Info label="Submitted">{formatDate(l.submittedAt)}</Info>
            <Info label="Decided">{formatDate(l.decidedAt)}</Info>
            <Info label="Disbursed">{formatDate(l.disbursedAt)}</Info>
            <Info label="Product">{l.productCode}</Info>
            <Info label="Status">{l.status}</Info>
          </div>
          {l.purpose && (
            <p className="text-sm mt-3">
              <span className="text-fg-muted">Purpose: </span>
              {l.purpose}
            </p>
          )}
          {l.decisionReason && (
            <p className="text-sm mt-3 text-danger">
              <span className="text-fg-muted">Reason: </span>
              {l.decisionReason}
            </p>
          )}
          {payable && (
            <div className="mt-4 flex flex-wrap gap-2">
              <PayNowButton loanId={l.id} />
              <PortalDocsButtons
                loanId={l.id}
                loanNumber={l.number}
                status={l.status}
              />
            </div>
          )}
          {!payable &&
            !["DRAFT", "SUBMITTED", "UNDER_REVIEW"].includes(l.status) && (
              <div className="mt-4">
                <PortalDocsButtons
                  loanId={l.id}
                  loanNumber={l.number}
                  status={l.status}
                />
              </div>
            )}

          {![
            "DRAFT",
            "SUBMITTED",
            "UNDER_REVIEW",
            "REJECTED",
            "CANCELLED",
          ].includes(l.status) && (
            <PortalSignaturePanel
              loanId={l.id}
              borrowerSignatureUrl={l.borrowerSignatureUrl}
              borrowerSignedAt={l.borrowerSignedAt}
            />
          )}
        </CardContent>
      </Card>

      {/* Direct line to the loan officer. Available once the
          application is past DRAFT — borrowers can ask questions about
          their submission, expected timelines, etc. */}
      {l.status !== "DRAFT" && (
        <LoanMessagePanel loanId={l.id} perspective="BORROWER" />
      )}
    </div>
  );
}

function PortalSignaturePanel({
  loanId,
  borrowerSignatureUrl,
  borrowerSignedAt,
}: {
  loanId: string;
  borrowerSignatureUrl: string | null;
  borrowerSignedAt: string | null;
}) {
  const [open, setOpen] = useState(false);
  const upload = useUpload();
  const sign = useSignAsBorrower("portal");
  const toast = useToast();

  const onCapture = async (blob: Blob) => {
    try {
      const file = new File([blob], "borrower-signature.png", {
        type: "image/png",
      });
      const result = await upload.mutateAsync({ file, subdir: "signatures" });
      await sign.mutateAsync({ loanId, signatureUrl: result.url });
      toast.success("Signature saved");
      setOpen(false);
    } catch (err) {
      toast.error((err as Error).message ?? "Failed");
    }
  };

  return (
    <div className="mt-6 border-t border-default pt-4 space-y-2">
      <div className="text-xs uppercase tracking-wider text-fg-muted flex items-center gap-1">
        <Pen className="h-3 w-3" />
        Your signature on the loan agreement
      </div>
      {borrowerSignatureUrl ? (
        <div className="flex items-center gap-3">
          <img
            src={borrowerSignatureUrl}
            alt="your signature"
            className="h-16 bg-white rounded p-1 border border-default"
          />
          <div className="text-xs text-fg-muted">
            <Badge variant="success">Signed</Badge>
            {borrowerSignedAt && (
              <div className="mt-1">
                on {new Date(borrowerSignedAt).toLocaleDateString()}
              </div>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            <Pen className="h-3 w-3" />
            Re-sign
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-fg-muted">
            Please sign your loan agreement. Your signature will be embedded in
            the official document.
          </p>
          <Button onClick={() => setOpen(true)}>
            <Pen className="h-3 w-3" />
            Sign agreement
          </Button>
        </div>
      )}

      {open && (
        <Dialog open onOpenChange={(o) => !o && setOpen(false)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Sign your loan agreement</DialogTitle>
            </DialogHeader>
            <SignaturePad
              onSubmit={onCapture}
              submitting={upload.isPending || sign.isPending}
              label="Draw your signature with mouse, stylus, or touch."
            />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function PayNowButton({ loanId }: { loanId: string }) {
  const create = usePortalCreatePaymentIntent();
  const toast = useToast();
  const [amount, setAmount] = useState(0);
  const [intentId, setIntentId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const intent = usePortalPaymentIntent(intentId, {
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
    await navigator.clipboard.writeText(intent.data.paymentUrl);
    toast.success("Link copied");
  };

  const reset = () => {
    setOpen(false);
    setIntentId(null);
    setAmount(0);
  };

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Link2 className="h-3 w-3" />
        Pay now
      </Button>
      {open && (
        <Dialog open onOpenChange={(o) => !o && reset()}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Make a payment</DialogTitle>
            </DialogHeader>
            {!intentId ? (
              <div className="space-y-3">
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
                    {create.isPending ? "Generating…" : "Continue"}
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
                  Open the link to complete payment via the provider.
                </p>
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

function PortalDocsButtons({
  loanId,
  loanNumber,
  status,
}: {
  loanId: string;
  loanNumber: string;
  status: string;
}) {
  const toast = useToast();
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
  const download = async (kind: "agreement" | "statement") => {
    try {
      await downloadPdf(
        `/portal/loans/${loanId}/${kind}.pdf`,
        `${kind}-${loanNumber}.pdf`,
      );
    } catch (err) {
      toast.error((err as Error).message ?? "Download failed");
    }
  };
  return (
    <>
      {showAgreement && (
        <Button variant="outline" onClick={() => download("agreement")}>
          <FileText className="h-3 w-3" />
          <Download className="h-3 w-3" />
          Agreement
        </Button>
      )}
      {showStatement && (
        <Button variant="outline" onClick={() => download("statement")}>
          <FileText className="h-3 w-3" />
          <Download className="h-3 w-3" />
          Statement
        </Button>
      )}
    </>
  );
}

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
      <div>{children ?? "—"}</div>
    </div>
  );
}

function badgeVariant(
  status: string,
): "success" | "danger" | "muted" | "warning" {
  if (["APPROVED", "DISBURSED", "ACTIVE"].includes(status)) return "success";
  if (["REJECTED", "DEFAULTED", "CANCELLED"].includes(status)) return "danger";
  if (status === "CLOSED") return "muted";
  return "warning";
}
