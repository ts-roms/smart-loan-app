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
  SkeletonCard,
  useToast,
} from "@loan/ui";
import { formatDate } from "@loan/shared-utils";
import { FileUp } from "lucide-react";
import { useState, type FormEvent } from "react";

// Direct import — see customers/constants.ts for why.
import { DocumentThumbnail } from "../../../components/DocumentPreview";
import { FileUpload } from "../../../components/FileUpload";
import { CAMERA_MODE, DOC_TYPE_LABELS } from "../../customers/constants";

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
 * Self-serve KYC document upload.
 *
 * This asked for a document URL until now, which no borrower can
 * produce — it presumed they had already hosted the file somewhere.
 * It uses the same capture widget as the officer form: camera-first
 * for anything photographed (ID, selfie, OR/CR, title), file picker
 * for the rest, streamed through /uploads-api/kyc for a stable URL
 * before the submission is posted.
 *
 * Uploading is open to any authenticated user by design — the returned
 * UUID URL is inert until a gated endpoint stores it, and this one is
 * gated on the borrower's own record. See uploads.routes.ts.
 */
export function PortalKyc() {
  const kyc = usePortalKyc();
  const submit = usePortalSubmitKyc();
  const toast = useToast();
  /**
   * One staged file per document type. Borrowers photograph their ID,
   * payslip and utility bill in one sitting; submitting them one at a
   * time meant three round trips through the same form.
   */
  const [staged, setStaged] = useState<
    Partial<Record<KycDocumentType, string>>
  >({});
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const stagedTypes = DOC_OPTIONS.filter((t) => staged[t]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (stagedTypes.length === 0) {
      toast.error("Attach a photo or file first");
      return;
    }
    setBusy(true);
    // Sequential: the API takes one document per call, and a failure
    // has to name which one so the borrower knows what to retry.
    const failed: string[] = [];
    let sent = 0;
    for (const documentType of stagedTypes) {
      try {
        await submit.mutateAsync({
          documentType,
          documentUrl: staged[documentType]!,
          notes: notes || undefined,
        });
        sent += 1;
        // Cleared as they land, so a mid-way failure leaves exactly
        // the unsent ones attached.
        setStaged((prev) => {
          const next = { ...prev };
          delete next[documentType];
          return next;
        });
      } catch {
        failed.push(DOC_TYPE_LABELS[documentType] ?? documentType);
      }
    }
    setBusy(false);
    if (sent > 0 && failed.length === 0) {
      toast.success(
        sent === 1
          ? "Document submitted for review"
          : `${sent} documents submitted for review`,
      );
      setNotes("");
    } else if (sent > 0) {
      toast.error(`${sent} sent · couldn't send ${failed.join(", ")}`);
    } else {
      toast.error(`Couldn't send ${failed.join(", ")}`);
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
            Submit documents
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-3">
            <p className="text-xs text-fg-muted">
              Attach whichever you have — they&apos;re sent together.
            </p>
            <ul className="space-y-2">
              {DOC_OPTIONS.map((d) => (
                <li
                  key={d}
                  className="flex items-center gap-2 rounded border border-default bg-surface-2 px-2 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-xs truncate">
                      {DOC_TYPE_LABELS[d] ?? d}
                    </div>
                    <div className="text-[10px] text-fg-subtle">
                      {CAMERA_MODE[d] ? "Photo or file" : "PDF or image"}
                    </div>
                  </div>
                  <FileUpload
                    subdir="kyc"
                    value={staged[d] ?? null}
                    onUploaded={(url) =>
                      setStaged((prev) => ({ ...prev, [d]: url }))
                    }
                    onClear={() =>
                      setStaged((prev) => {
                        const next = { ...prev };
                        delete next[d];
                        return next;
                      })
                    }
                    capture={CAMERA_MODE[d]}
                    label="Choose a file"
                  />
                </li>
              ))}
            </ul>
            <div className="space-y-1">
              <label className="text-xs text-fg-muted">Notes (optional)</label>
              <Input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Anything an officer should know"
              />
            </div>
            <Button type="submit" disabled={busy || stagedTypes.length === 0}>
              {busy
                ? "Submitting…"
                : stagedTypes.length <= 1
                  ? "Submit for review"
                  : `Submit ${stagedTypes.length} for review`}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
