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
import { FileUp, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

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
    Array<{ type: KycDocumentType; url: string }>
  >([]);
  const [documentType, setDocumentType] = useState<KycDocumentType>(
    DOC_OPTIONS[0]!,
  );
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const remaining = DOC_OPTIONS.filter(
    (d) => !staged.some((x) => x.type === d),
  );

  // Keep the picker on something still offerable — the selected type
  // leaves `remaining` as soon as it's attached.
  useEffect(() => {
    if (remaining.length > 0 && !remaining.includes(documentType)) {
      setDocumentType(remaining[0]!);
    }
  }, [remaining, documentType]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (staged.length === 0) {
      toast.error("Attach a photo or file first");
      return;
    }
    setBusy(true);
    // Sequential: the API takes one document per call, and a failure
    // has to name which one so the borrower knows what to retry.
    const failed: string[] = [];
    let sent = 0;
    for (const item of staged) {
      try {
        await submit.mutateAsync({
          documentType: item.type,
          documentUrl: item.url,
          notes: notes || undefined,
        });
        sent += 1;
        // Dropped as they land, so a mid-way failure leaves exactly
        // the unsent ones attached.
        setStaged((prev) => prev.filter((x) => x.type !== item.type));
      } catch {
        failed.push(DOC_TYPE_LABELS[item.type] ?? item.type);
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
              Add one at a time — they&apos;re sent together.
            </p>

            {staged.length > 0 && (
              <ul className="space-y-1">
                {staged.map((item) => (
                  <li
                    key={item.type}
                    className="flex items-center gap-2 rounded border border-default bg-surface-2 px-2 py-1.5"
                  >
                    <DocumentThumbnail
                      url={item.url}
                      label={DOC_TYPE_LABELS[item.type] ?? item.type}
                      className="h-8 w-8"
                    />
                    <span className="flex-1 min-w-0 truncate text-xs">
                      {DOC_TYPE_LABELS[item.type] ?? item.type}
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove ${DOC_TYPE_LABELS[item.type] ?? item.type}`}
                      onClick={() =>
                        setStaged((prev) =>
                          prev.filter((x) => x.type !== item.type),
                        )
                      }
                      className="text-fg-subtle hover:text-danger"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {remaining.length > 0 && (
              <div className="space-y-2">
                <Select
                  value={documentType}
                  onValueChange={(v) => setDocumentType(v as KycDocumentType)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {remaining.map((d) => (
                      <SelectItem key={d} value={d}>
                        {DOC_TYPE_LABELS[d] ?? d}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {/* Keyed so the widget resets between documents; an
                    attached file moves to the list above, so this is
                    only ever the capture button. */}
                <FileUpload
                  key={documentType}
                  subdir="kyc"
                  value={null}
                  onUploaded={(url) =>
                    setStaged((prev) => [...prev, { type: documentType, url }])
                  }
                  capture={CAMERA_MODE[documentType]}
                  label="Choose a file"
                />
              </div>
            )}

            <div className="space-y-1">
              <label className="text-xs text-fg-muted">Notes (optional)</label>
              <Input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Anything an officer should know"
              />
            </div>
            <Button type="submit" disabled={busy || staged.length === 0}>
              {busy
                ? "Submitting…"
                : staged.length <= 1
                  ? "Submit for review"
                  : `Submit ${staged.length} for review`}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
