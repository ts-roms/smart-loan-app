import {
  useCoMakerInvite,
  useCoMakerRespond,
  useCoMakerUpload,
} from "@loan/api-client";
import type { KycDocumentType } from "@loan/shared-types";
import { formatDateTime, formatMoney } from "@loan/shared-utils";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  SkeletonCard,
  useToast,
} from "@loan/ui";
import { CheckCircle2, FileUp, ShieldAlert, XCircle } from "lucide-react";
import { useRef, useState } from "react";
import { useParams } from "react-router-dom";

import { DocumentThumbnail } from "../../../components/DocumentPreview";
import { DOC_TYPE_LABELS } from "../../customers/constants";

/**
 * What a co-maker sees when they open their invite link.
 *
 * No account, no password — the token in the URL is the credential,
 * which is the only thing that works for someone who is a parent or an
 * employer rather than a customer. Rendered outside both app shells:
 * there's no nav to show them and nothing else here they can reach.
 *
 * The page leads with what they're agreeing to. A co-maker is jointly
 * liable for the whole amount, and someone clicking a link from an SMS
 * deserves to see the borrower, the sum and the term before the
 * buttons.
 */
export function CoMakerConsentPage() {
  const { token = "" } = useParams<{ token: string }>();
  const invite = useCoMakerInvite(token);
  const respond = useCoMakerRespond(token);
  const toast = useToast();
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");

  if (invite.isLoading) {
    return (
      <Shell>
        <SkeletonCard />
      </Shell>
    );
  }

  if (invite.isError || !invite.data) {
    // Covers expired and revoked alike — a resend mints a new token,
    // so an old link landing here is expected rather than exceptional.
    return (
      <Shell>
        <Card>
          <CardContent className="py-10 text-center space-y-2">
            <ShieldAlert className="mx-auto h-8 w-8 text-warning" />
            <div className="text-sm font-medium">
              This link isn&apos;t valid
            </div>
            <p className="text-xs text-fg-muted">
              It may have expired or been replaced by a newer one. Ask the
              lending officer who contacted you to send a fresh link.
            </p>
          </CardContent>
        </Card>
      </Shell>
    );
  }

  const d = invite.data;
  const answered = d.status !== "PENDING";

  const submit = async (decision: "APPROVED" | "DECLINED") => {
    if (decision === "DECLINED" && !reason.trim()) {
      toast.error("Please tell us why you're declining.");
      return;
    }
    try {
      await respond.mutateAsync({
        decision,
        declineReason: decision === "DECLINED" ? reason.trim() : undefined,
      });
      toast.success(
        decision === "APPROVED"
          ? "Thank you — your agreement has been recorded."
          : "Recorded. The lender has been notified.",
      );
      setDeclining(false);
    } catch (err) {
      toast.error((err as Error).message ?? "Could not record your answer");
    }
  };

  return (
    <Shell companyName={d.lender.companyName}>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {d.fullName}, you&apos;ve been named as a {roleLabel(d.role)}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-fg-muted">
            <strong className="text-fg">{d.loan.borrowerName}</strong> has
            applied for a loan and named you as their {roleLabel(d.role)}.
          </p>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Fact label="Loan" value={d.loan.number} />
            <Fact label="Amount" value={formatMoney(d.loan.principal)} />
            <Fact label="Term" value={`${d.loan.termMonths} months`} />
            <Fact label="Product" value={d.loan.productName || "—"} />
          </div>

          {/* Said plainly. Someone agreeing to this from a text message
              should not have to infer what it means. */}
          <div className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-fg">
            Agreeing means you are <strong>jointly liable</strong> for this
            loan. If {d.loan.borrowerName.split(" ")[0]} does not pay,{" "}
            {d.lender.companyName} can collect the full outstanding amount from
            you.
          </div>

          {answered ? (
            <Answered
              status={d.status}
              respondedAt={d.respondedAt}
              company={d.lender.companyName}
            />
          ) : declining ? (
            <div className="space-y-2">
              <label className="text-xs text-fg-muted">
                Why are you declining?
              </label>
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. I wasn't asked about this"
                autoFocus
              />
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => void submit("DECLINED")}
                  disabled={respond.isPending}
                >
                  Confirm decline
                </Button>
                <Button variant="ghost" onClick={() => setDeclining(false)}>
                  Back
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => void submit("APPROVED")}
                disabled={respond.isPending}
              >
                <CheckCircle2 className="h-4 w-4" />I agree to be a{" "}
                {roleLabel(d.role)}
              </Button>
              <Button variant="outline" onClick={() => setDeclining(true)}>
                <XCircle className="h-4 w-4" />
                Decline
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Documents only once they've agreed — asking someone to hand
          over their ID before they've said yes has it backwards. */}
      {d.status === "APPROVED" && (
        <Requirements
          token={token}
          required={d.requiredDocuments}
          uploaded={d.documents}
        />
      )}
    </Shell>
  );
}

function Answered({
  status,
  respondedAt,
  company,
}: {
  status: string;
  respondedAt: string | null;
  company: string;
}) {
  const approved = status === "APPROVED";
  return (
    <div
      className={`rounded-md border px-3 py-2 text-sm ${
        approved
          ? "border-success/30 bg-success-soft"
          : "border-danger/30 bg-danger-soft"
      }`}
    >
      <div className="flex items-center gap-2 font-medium">
        {approved ? (
          <CheckCircle2 className="h-4 w-4 text-success" />
        ) : (
          <XCircle className="h-4 w-4 text-danger" />
        )}
        {approved ? "You agreed to this" : "You declined this"}
      </div>
      <div className="text-xs text-fg-muted mt-1">
        Recorded {respondedAt ? formatDateTime(respondedAt) : ""}. To change
        your answer, contact {company} — they&apos;ll send a new link.
      </div>
    </div>
  );
}

/** Upload the documents the product asks of anyone on the hook. */
function Requirements({
  token,
  required,
  uploaded,
}: {
  token: string;
  required: KycDocumentType[];
  uploaded: Array<{
    id: string;
    documentType: KycDocumentType;
    documentUrl: string;
  }>;
}) {
  const upload = useCoMakerUpload(token);
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<KycDocumentType | null>(null);

  const done = new Set(uploaded.map((u) => u.documentType));
  // Fall back to an ID when the product asks for nothing specific —
  // "upload your requirements" with no list is not an instruction.
  const asked =
    required.length > 0 ? required : (["ID_FRONT"] as KycDocumentType[]);

  const pick = (type: KycDocumentType) => {
    setPending(type);
    fileRef.current?.click();
  };

  const onFile = async (file: File | undefined) => {
    if (!file || !pending) return;
    try {
      await upload.mutateAsync({ file, documentType: pending });
      toast.success("Uploaded");
    } catch (err) {
      toast.error((err as Error).message ?? "Upload failed");
    } finally {
      setPending(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <FileUp className="h-4 w-4" />
          Your requirements
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-fg-muted">
          Photograph or upload each one. Clear, well-lit images of the whole
          document work best.
        </p>
        <input
          ref={fileRef}
          type="file"
          accept="image/*,application/pdf"
          capture="environment"
          className="hidden"
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
        <ul className="divide-y divide-default">
          {asked.map((type) => {
            const file = uploaded.find((u) => u.documentType === type);
            return (
              <li key={type} className="flex items-center gap-2 py-2 text-sm">
                {file && (
                  <DocumentThumbnail
                    url={file.documentUrl}
                    label={DOC_TYPE_LABELS[type] ?? type}
                  />
                )}
                <span className="flex-1 min-w-0 truncate">
                  {DOC_TYPE_LABELS[type] ?? type}
                </span>
                {done.has(type) ? (
                  <Badge variant="success">Uploaded</Badge>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => pick(type)}
                    disabled={upload.isPending}
                  >
                    {upload.isPending && pending === type
                      ? "Uploading…"
                      : "Upload"}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

function Shell({
  children,
  companyName,
}: {
  children: React.ReactNode;
  companyName?: string;
}) {
  return (
    <div className="min-h-screen bg-surface-1 px-4 py-8">
      <div className="mx-auto w-full max-w-2xl space-y-4">
        {companyName && (
          <div className="text-center text-xs uppercase tracking-wider text-fg-subtle">
            {companyName}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-default bg-surface-2 p-2">
      <div className="text-[10px] uppercase tracking-wider text-fg-subtle">
        {label}
      </div>
      <div className="text-sm font-medium truncate">{value}</div>
    </div>
  );
}

function roleLabel(role: string): string {
  return role === "CO_BORROWER"
    ? "co-borrower"
    : role === "GUARANTOR"
      ? "guarantor"
      : "co-maker";
}
