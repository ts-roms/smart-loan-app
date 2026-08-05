import { usePortalKyc, usePortalSubmitKyc } from "@loan/api-client";
import type { KycDocumentType } from "@loan/shared-types";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SkeletonCard,
  useToast,
} from "@loan/ui";
import { formatDate } from "@loan/shared-utils";
import { FileUp } from "lucide-react";
import { useState, type FormEvent } from "react";

// Direct import — see customers/constants.ts for why.
import { DocumentThumbnail } from "../../../components/DocumentPreview";
import { DOC_TYPE_LABELS } from "../../customers/constants";

const DOC_OPTIONS: KycDocumentType[] = [
  "ID_FRONT",
  "ID_BACK",
  "PROOF_OF_INCOME",
  "PROOF_OF_ADDRESS",
  "SELFIE",
  "VEHICLE_OR",
  "VEHICLE_CR",
  "PROPERTY_TITLE",
  "TAX_DECLARATION",
];

/**
 * Self-serve KYC document upload. We don't ship a file uploader here yet —
 * the customer pastes a URL pointing at the file they uploaded (matching
 * how the officer flow works today). A real implementation would wire
 * multipart upload into /uploads/kyc.
 */
export function PortalKyc() {
  const kyc = usePortalKyc();
  const submit = usePortalSubmitKyc();
  const toast = useToast();
  const [documentType, setDocumentType] = useState<KycDocumentType>("ID_FRONT");
  const [documentUrl, setDocumentUrl] = useState("");
  const [notes, setNotes] = useState("");

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await submit.mutateAsync({
        documentType,
        documentUrl,
        notes: notes || undefined,
      });
      toast.success("Document submitted for review");
      setDocumentUrl("");
      setNotes("");
    } catch (err) {
      toast.error((err as Error).message ?? "Could not submit");
    }
  };

  if (kyc.isLoading) return <SkeletonCard />;

  const status = kyc.data?.status;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>My documents</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {status && (
            <div className="text-sm">
              <Badge variant={status.complete ? "success" : "warning"}>
                {status.status}
              </Badge>
              {status.missing.length > 0 && (
                <div className="mt-2 text-xs text-warning">
                  Still missing:{" "}
                  {status.missing
                    .map((m) => DOC_TYPE_LABELS[m] ?? m)
                    .join(", ")}
                </div>
              )}
            </div>
          )}
          {(kyc.data?.docs ?? []).length === 0 ? (
            <p className="text-sm text-fg-muted">No documents submitted yet.</p>
          ) : (
            <ul className="divide-y divide-default text-sm">
              {(kyc.data?.docs ?? []).map((d) => (
                <li
                  key={d.id}
                  className="py-2 flex items-center justify-between gap-2"
                >
                  {/* Borrowers resubmit blurry photos — they need to
                      see what they actually sent. */}
                  <DocumentThumbnail
                    url={d.documentUrl}
                    label={DOC_TYPE_LABELS[d.documentType] ?? d.documentType}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate">
                      {DOC_TYPE_LABELS[d.documentType] ?? d.documentType}
                    </div>
                    <div className="text-xs text-fg-subtle">
                      {formatDate(d.submittedAt)}
                    </div>
                    {d.status === "REJECTED" && d.reason && (
                      <div className="text-xs text-danger mt-0.5">
                        {d.reason}
                      </div>
                    )}
                  </div>
                  <Badge
                    variant={
                      d.status === "VERIFIED"
                        ? "success"
                        : d.status === "REJECTED"
                          ? "danger"
                          : "warning"
                    }
                  >
                    {d.status}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileUp className="h-4 w-4" />
            Submit a new document
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs text-fg-muted">Document type</label>
              <Select
                value={documentType}
                onValueChange={(v) => setDocumentType(v as KycDocumentType)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DOC_OPTIONS.map((d) => (
                    <SelectItem key={d} value={d}>
                      {DOC_TYPE_LABELS[d] ?? d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-fg-muted">Document URL</label>
              <Input
                placeholder="https://… (upload your scan first)"
                value={documentUrl}
                onChange={(e) => setDocumentUrl(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-fg-muted">Notes (optional)</label>
              <Input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Anything an officer should know"
              />
            </div>
            <Button type="submit" disabled={submit.isPending || !documentUrl}>
              {submit.isPending ? "Submitting…" : "Submit for review"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
