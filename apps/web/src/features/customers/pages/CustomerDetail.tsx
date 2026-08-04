import {
  useCustomer,
  useCustomerScore,
  useKycForCustomer,
  useKycStatus,
  useSubmitKyc,
} from "@loan/api-client";
import type {
  CreditTier,
  Customer,
  KycDocumentType,
  KycSubmission,
} from "@loan/shared-types";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SkeletonCard,
  useToast,
} from "@loan/ui";
import { FileUpload } from "../../../components/FileUpload";
import { formatDate, formatMoney } from "@loan/shared-utils";
import { FileUp, Gauge, Pencil, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

import { CustomerLedgerPanel } from "../components/CustomerLedgerPanel";
import { DorsiScreenBanner } from "../components/DorsiScreenBanner";
import { EditCustomerDialog } from "../components/EditCustomerDialog";
import { DOC_TYPES, DOC_TYPE_LABELS } from "../constants";

// Re-exported here for back-compat with anything that still imports
// from this file path. New code should import from
// `features/customers/constants` directly so it doesn't pull this
// page's chunk in for a constant.
export { DOC_TYPE_LABELS };

/**
 * Per-customer drill-down: profile, KYC pack with submit-doc form,
 * current credit score (with tier + breakdown), and CTAs to (re)take
 * the credit-scoring survey or apply for a loan.
 */
export function CustomerDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const customer = useCustomer(id);
  const kycDocs = useKycForCustomer(id);
  const kycStatus = useKycStatus(id);
  const score = useCustomerScore(id);
  const [editing, setEditing] = useState(false);

  if (customer.isLoading) return <SkeletonCard />;
  if (!customer.data)
    return <p className="text-sm text-fg-muted">Customer not found.</p>;
  const c = customer.data;

  const fullName = [c.firstName, c.middleName, c.lastName]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="space-y-4">
      <DorsiScreenBanner customerId={c.id} customerName={fullName} />
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <div>
            {/* Reference number first — operators identify customers by
                CUST-... in conversation; the name is secondary context. */}
            <div className="font-mono text-[11px] uppercase tracking-wider text-fg-subtle mb-1">
              {c.number}
            </div>
            <CardTitle>
              {c.firstName} {c.middleName ? `${c.middleName} ` : ""}
              {c.lastName}
            </CardTitle>
            <div className="text-xs text-fg-muted mt-1">
              {c.phone} · {c.email ?? "—"} · DOB {formatDate(c.dateOfBirth)}
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="inline-flex items-center gap-1 rounded-md border border-default bg-surface-3 px-3 py-1.5 text-sm hover:bg-hover"
            >
              <Pencil className="h-4 w-4" />
              Edit profile
            </button>
            <Link
              to={`/customers/${id}/survey`}
              className="inline-flex items-center gap-1 rounded-md border border-default bg-surface-3 px-3 py-1.5 text-sm hover:bg-hover"
            >
              <Gauge className="h-4 w-4" />
              {score.data ? "Re-score" : "Take credit survey"}
            </Link>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {/* Top row — quick identity + income facts the operator
              wants at a glance. Same shape as before for back-compat. */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Info label="Address">{formatAddress(c)}</Info>
            <Info label="Gov't ID">
              {c.governmentIdType} · {c.governmentIdNumber}
            </Info>
            <Info label="Employment">
              {c.employmentStatus}
              {c.jobTitle
                ? ` · ${c.jobTitle}`
                : c.position
                  ? ` · ${c.position}`
                  : ""}
            </Info>
            <Info label="Monthly income">
              {formatMoney(Number(c.monthlyIncome))}
            </Info>
          </div>

          {/* Expanded personal — only renders fields that have values
              so a sparsely-filled profile doesn't look broken. */}
          <ExpandedDetails customer={c} />
        </CardContent>
      </Card>

      {/* Unified statement of account — loans + cooperative activity. */}
      <CustomerLedgerPanel idOrNumber={id} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Gauge className="h-4 w-4 text-info" />
              Credit score
            </CardTitle>
          </CardHeader>
          <CardContent>
            {score.isLoading ? (
              <p className="text-sm text-fg-muted">Loading…</p>
            ) : score.data ? (
              <div className="space-y-3">
                <div className="flex items-end gap-3">
                  <div className="text-4xl font-semibold tracking-tight">
                    {score.data.score}
                  </div>
                  <TierBadge tier={score.data.tier} />
                </div>
                <div className="text-xs text-fg-muted">
                  Last scored {formatDate(score.data.computedAt)}
                </div>
                <ul className="text-xs divide-y divide-default">
                  {score.data.breakdown.slice(0, 6).map((b) => (
                    <li
                      key={b.factorId}
                      className="flex justify-between py-1.5"
                    >
                      <span className="text-fg">{b.label}</span>
                      <span className="font-mono">
                        {b.points.toFixed(1)} / {b.maxPoints}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-sm text-fg-muted">
                No score yet — run the survey.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-success" />
              KYC
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {kycStatus.data && (
              <div className="text-sm">
                Rollup status:{" "}
                <Badge
                  variant={
                    kycStatus.data.status === "VERIFIED"
                      ? "success"
                      : kycStatus.data.status === "REJECTED"
                        ? "danger"
                        : kycStatus.data.status === "PENDING"
                          ? "warning"
                          : "muted"
                  }
                >
                  {kycStatus.data.status}
                </Badge>
                {kycStatus.data.missing.length > 0 && (
                  <div className="text-xs text-warning mt-1">
                    Missing:{" "}
                    {kycStatus.data.missing
                      .map((m) => DOC_TYPE_LABELS[m])
                      .join(", ")}
                  </div>
                )}
              </div>
            )}
            <ul className="text-xs divide-y divide-default">
              {(kycDocs.data ?? []).map((d) => (
                <li key={d.id} className="py-1.5 flex justify-between">
                  <span>
                    {DOC_TYPE_LABELS[d.documentType] ?? d.documentType}
                  </span>
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
            <SubmitKycForm customerId={c.id} existing={kycDocs.data ?? []} />
          </CardContent>
        </Card>
      </div>

      {editing && (
        <EditCustomerDialog customer={c} onClose={() => setEditing(false)} />
      )}
    </div>
  );
}

/**
 * Document types that ship with a camera-first flow. SELFIE uses the
 * front-facing lens; physical ID / OR / CR / title shots default to the
 * rear camera (better for sharp photos of a document on a desk).
 * Anything else falls through to the plain file picker (typed PDFs,
 * income docs, tax declarations).
 */
const CAMERA_MODE: Partial<Record<KycDocumentType, "user" | "environment">> = {
  SELFIE: "user",
  ID_FRONT: "environment",
  ID_BACK: "environment",
  VEHICLE_OR: "environment",
  VEHICLE_CR: "environment",
  PROPERTY_TITLE: "environment",
};

/**
 * Inline KYC submission form. Replaces the old paste-a-URL flow with a
 * proper capture/upload widget — operators can now snap a photo with
 * the webcam (or rear camera on a tablet) or drop in a file, and we
 * stream it through the uploads service to get a stable URL before
 * posting to /kyc.
 *
 * The doc-type dropdown filters out anything that already has a
 * PENDING or VERIFIED submission for this customer, so a stray click
 * can't double-create a row. Hidden types light back up automatically
 * once an officer marks a previous submission as REJECTED.
 *
 * 409 Conflict responses (the API's last-line defence) surface as a
 * specific toast — operators know it's a dup, not a generic failure.
 */
function SubmitKycForm({
  customerId,
  existing,
}: {
  customerId: string;
  existing: KycSubmission[];
}) {
  const submit = useSubmitKyc();
  const toast = useToast();

  // Block doc types that are already pending/verified — the user can
  // still resubmit if a previous attempt was rejected.
  const taken = useMemo(() => {
    const set = new Set<KycDocumentType>();
    for (const d of existing) {
      if (d.status === "PENDING" || d.status === "VERIFIED")
        set.add(d.documentType);
    }
    return set;
  }, [existing]);

  const available = useMemo(
    () => DOC_TYPES.filter((t) => !taken.has(t.value)),
    [taken],
  );

  // Whenever the available set changes, snap the active type to the
  // first one that's still allowed. Avoids a stuck form where the
  // dropdown shows a value the user can't actually submit.
  const [documentType, setDocumentType] = useState<KycDocumentType>(
    available[0]?.value ?? "ID_FRONT",
  );
  const [documentUrl, setDocumentUrl] = useState("");

  // If the currently-selected type just became taken (e.g. the operator
  // submitted it from another tab), bump the selection to the next free
  // slot so we don't show a disabled-looking form.
  useEffect(() => {
    if (
      taken.has(documentType) &&
      available[0] &&
      available[0].value !== documentType
    ) {
      setDocumentType(available[0].value);
      setDocumentUrl("");
    }
  }, [taken, documentType, available]);

  const onSubmit = async () => {
    try {
      await submit.mutateAsync({ customerId, documentType, documentUrl });
      toast.success("Document submitted");
      setDocumentUrl("");
    } catch (err) {
      // Duplicate-conflict has its own copy — generic catch-all otherwise.
      const msg = (err as Error).message ?? "";
      if (/already exists/i.test(msg)) {
        toast.error(
          "A submission for this document type is already on file. Resubmit only after the existing one is rejected.",
        );
      } else {
        toast.error(msg || "Could not submit");
      }
    }
  };

  if (available.length === 0) {
    return (
      <div className="border-t border-default pt-3 text-xs text-fg-subtle">
        <FileUp className="inline h-3 w-3 mr-1" />
        All document types have an active submission. Mark one as rejected above
        to allow a fresh upload.
      </div>
    );
  }

  const captureMode = CAMERA_MODE[documentType];

  return (
    <div className="space-y-3 border-t border-default pt-3">
      <div className="text-xs text-fg-subtle flex items-center gap-1">
        <FileUp className="h-3 w-3" />
        Submit a document
      </div>
      <Select
        value={documentType}
        onValueChange={(v) => {
          setDocumentType(v as KycDocumentType);
          // Reset the staged upload when the type changes — the asset
          // was tied to the previous type's capture mode.
          setDocumentUrl("");
        }}
      >
        <SelectTrigger className="h-9">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {available.map((t) => (
            <SelectItem key={t.value} value={t.value}>
              {t.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="space-y-1">
        <div className="text-[10px] uppercase tracking-wider text-fg-subtle">
          {captureMode === "user"
            ? "Capture selfie or upload a photo"
            : captureMode === "environment"
              ? "Photograph the document or upload a file"
              : "Upload a file (PDF or image)"}
        </div>
        <FileUpload
          subdir="kyc"
          value={documentUrl || null}
          onUploaded={setDocumentUrl}
          onClear={() => setDocumentUrl("")}
          capture={captureMode}
          label="Choose file"
        />
      </div>

      <Button
        type="button"
        size="sm"
        className="w-full"
        onClick={onSubmit}
        disabled={submit.isPending || !documentUrl}
      >
        {submit.isPending ? "Submitting…" : "Submit document"}
      </Button>
    </div>
  );
}

function TierBadge({ tier }: { tier: CreditTier }) {
  const map: Record<CreditTier, { cls: string; label: string }> = {
    A: {
      cls: "bg-emerald-500/15 text-success border-emerald-400/30",
      label: "A · Prime",
    },
    B: {
      cls: "bg-sky-500/15 text-info border-sky-400/30",
      label: "B · Good",
    },
    C: {
      cls: "bg-amber-500/15 text-warning border-amber-400/30",
      label: "C · Fair",
    },
    D: {
      cls: "bg-orange-500/15 text-warning border-orange-400/30",
      label: "D · Subprime",
    },
    F: {
      cls: "bg-rose-500/15 text-danger border-rose-400/30",
      label: "F · Decline",
    },
  };
  return (
    <span
      className={`px-2 py-0.5 rounded-md border text-xs font-medium ${map[tier].cls}`}
    >
      {map[tier].label}
    </span>
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
      <div className="text-sm">{children}</div>
    </div>
  );
}

/**
 * Pretty-print the full multi-line address. Skips any fields that are
 * null so a half-filled profile reads naturally instead of like a
 * comma-soup of placeholders.
 */
function formatAddress(c: Customer): string {
  const parts = [
    c.address,
    c.addressLine2,
    c.barangay,
    c.city,
    c.province,
    c.region,
    c.postalCode,
  ].filter((p) => p && String(p).trim());
  return parts.join(", ");
}

/**
 * Sub-panel rendering the expanded personal + employment fields. Built
 * as a separate component so the main CardContent stays readable.
 * Sections render conditionally — a SINGLE, unemployed customer
 * doesn't see empty Spouse + Employment blocks.
 */
function ExpandedDetails({ customer: c }: { customer: Customer }) {
  const hasPersonalExtras = c.suffix || c.gender || c.sex || c.civilStatus;
  const isMarried = c.civilStatus === "MARRIED";
  const hasEmployerExtras =
    c.position || c.hireDate || c.regularizationDate || c.yearsAtCurrentJob;
  const hasContactExtras = c.secondaryPhone;

  if (
    !hasPersonalExtras &&
    !isMarried &&
    !hasEmployerExtras &&
    !hasContactExtras
  ) {
    return null;
  }

  return (
    <div className="border-t border-default pt-3 space-y-4">
      {hasPersonalExtras && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-fg-subtle mb-2">
            Personal
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {c.suffix && <Info label="Suffix">{c.suffix}</Info>}
            {c.gender && <Info label="Gender">{prettifyEnum(c.gender)}</Info>}
            {c.sex && <Info label="Sex">{prettifyEnum(c.sex)}</Info>}
            {c.civilStatus && (
              <Info label="Civil status">{prettifyEnum(c.civilStatus)}</Info>
            )}
          </div>
        </div>
      )}

      {isMarried && (c.spouseName || c.spouseContact || c.spouseOccupation) && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-fg-subtle mb-2">
            Spouse
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {c.spouseName && <Info label="Name">{c.spouseName}</Info>}
            {c.spouseDateOfBirth && (
              <Info label="Date of birth">
                {formatDate(c.spouseDateOfBirth)}
              </Info>
            )}
            {c.spouseContact && <Info label="Contact">{c.spouseContact}</Info>}
            {c.spouseOccupation && (
              <Info label="Occupation">{c.spouseOccupation}</Info>
            )}
          </div>
        </div>
      )}

      {hasContactExtras && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-fg-subtle mb-2">
            Contact
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Info label="Primary phone">{c.phone}</Info>
            {c.secondaryPhone && (
              <Info label="Secondary phone">{c.secondaryPhone}</Info>
            )}
          </div>
        </div>
      )}

      {hasEmployerExtras && (
        <div>
          <div className="text-[10px] uppercase tracking-wider text-fg-subtle mb-2">
            Employment details
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {c.employerName && <Info label="Employer">{c.employerName}</Info>}
            {c.position && <Info label="Position">{c.position}</Info>}
            {c.hireDate && (
              <Info label="Hire date">{formatDate(c.hireDate)}</Info>
            )}
            {c.regularizationDate && (
              <Info label="Regularization">
                {formatDate(c.regularizationDate)}
              </Info>
            )}
            {c.yearsAtCurrentJob != null && (
              <Info label="Years at job">{String(c.yearsAtCurrentJob)}</Info>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Convert SCREAMING_SNAKE_CASE enum value into Title Case for display.
 * Cheap helper; we don't want to wire a full i18n table for these.
 */
function prettifyEnum(s: string): string {
  return s
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
