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
  SkeletonCard,
  useToast,
} from "@loan/ui";
import { DocumentThumbnail } from "../../../components/DocumentPreview";
import { FileUpload } from "../../../components/FileUpload";
import { formatDate, formatDateTime, formatMoney } from "@loan/shared-utils";
import { FileUp, Gauge, Pencil, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useCrumbTitle } from "../../../providers/breadcrumb-titles";

import { CustomerLedgerPanel } from "../components/CustomerLedgerPanel";
import { DorsiScreenBanner } from "../components/DorsiScreenBanner";
import { EditCustomerDialog } from "../components/EditCustomerDialog";
import { CAMERA_MODE, DOC_TYPES, DOC_TYPE_LABELS } from "../constants";

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
  // Every link into this page uses the customer NUMBER ("PICKER-008"),
  // and only /customers/:idOrNumber resolves one — the KYC and scoring
  // endpoints match on the UUID. Passing the URL param to them meant a
  // customer who had submitted documents and taken the survey saw an
  // empty KYC list and "no score yet", permanently.
  //
  // Null until the customer loads, which leaves the queries disabled
  // rather than firing a request that would 404.
  const customerId = customer.data?.id ?? null;
  const kycDocs = useKycForCustomer(customerId);
  const kycStatus = useKycStatus(customerId);
  const score = useCustomerScore(customerId);
  const [editing, setEditing] = useState(false);

  // Name the breadcrumb crumb for this route. Called before the early
  // returns below — it's a hook, and the loading branch would otherwise
  // change the hook order. Null while loading; the trail shows the id
  // until the record arrives.
  useCrumbTitle(
    customer.data
      ? [customer.data.firstName, customer.data.lastName]
          .filter(Boolean)
          .join(" ")
      : null,
  );

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
            {/* Submitted documents. The thumbnail is the point — the
                list used to be a type and a status badge, so there was
                no way to see what had actually been uploaded without
                going to the KYC review queue. */}
            <ul className="text-xs divide-y divide-default">
              {(kycDocs.data ?? []).map((d) => (
                <li key={d.id} className="py-2 flex items-center gap-2">
                  <DocumentThumbnail
                    url={d.documentUrl}
                    label={DOC_TYPE_LABELS[d.documentType] ?? d.documentType}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate">
                      {DOC_TYPE_LABELS[d.documentType] ?? d.documentType}
                    </div>
                    <div className="text-[10px] text-fg-subtle">
                      {formatDateTime(d.submittedAt)}
                    </div>
                    {/* Why it bounced — otherwise a REJECTED badge
                        tells an operator to resubmit without saying
                        what to fix. */}
                    {d.status === "REJECTED" && d.reason && (
                      <div className="text-[10px] text-danger mt-0.5">
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

  // Block doc types that already have an active submission — the
  // operator can still resubmit once a previous attempt is rejected.
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

  /**
   * One staged file per document type, keyed by type.
   *
   * A borrower arrives with their whole folder — ID, payslip, utility
   * bill — and the form used to take one, submit, reset, and start
   * over. Staging them all and submitting once matches how the
   * documents actually turn up.
   */
  const [staged, setStaged] = useState<
    Partial<Record<KycDocumentType, string>>
  >({});
  const [busy, setBusy] = useState(false);

  const stagedTypes = available
    .map((t) => t.value)
    .filter((t): t is KycDocumentType => Boolean(staged[t]));

  // A type that gets submitted (or resubmitted elsewhere) leaves
  // `available`; drop anything staged against it so the count can't
  // include a slot that's no longer on screen.
  useEffect(() => {
    setStaged((prev) => {
      const next: Partial<Record<KycDocumentType, string>> = {};
      for (const t of available) {
        if (prev[t.value]) next[t.value] = prev[t.value];
      }
      return next;
    });
  }, [available]);

  const onSubmit = async () => {
    if (stagedTypes.length === 0) return;
    setBusy(true);
    // Sequential rather than parallel: the API takes one document per
    // call, and a failure has to name the type it belongs to. Nine is
    // the ceiling, so there's nothing to gain from racing them.
    const failed: Array<{ type: KycDocumentType; message: string }> = [];
    let sent = 0;
    for (const documentType of stagedTypes) {
      try {
        await submit.mutateAsync({
          customerId,
          documentType,
          documentUrl: staged[documentType]!,
        });
        sent += 1;
        // Clear as we go, so a mid-way failure leaves exactly the
        // unsent ones staged and the operator can retry just those.
        setStaged((prev) => {
          const next = { ...prev };
          delete next[documentType];
          return next;
        });
      } catch (err) {
        const msg = (err as Error).message ?? "";
        failed.push({
          type: documentType,
          message: /already exists/i.test(msg)
            ? "already on file"
            : msg || "failed",
        });
      }
    }
    setBusy(false);

    if (sent > 0 && failed.length === 0) {
      toast.success(
        sent === 1 ? "Document submitted" : `${sent} documents submitted`,
      );
    } else if (sent > 0) {
      toast.error(
        `${sent} submitted · ${failed
          .map((f) => `${DOC_TYPE_LABELS[f.type] ?? f.type} ${f.message}`)
          .join(", ")}`,
      );
    } else {
      toast.error(
        failed
          .map((f) => `${DOC_TYPE_LABELS[f.type] ?? f.type}: ${f.message}`)
          .join(" · "),
      );
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

  return (
    <div className="space-y-3 border-t border-default pt-3">
      <div className="text-xs text-fg-subtle flex items-center gap-1">
        <FileUp className="h-3 w-3" />
        Submit documents
      </div>
      <p className="text-[10px] text-fg-subtle">
        Attach as many as you have — they go in together.
      </p>

      <ul className="space-y-2">
        {available.map((t) => (
          <KycSlot
            key={t.value}
            type={t.value}
            label={t.label}
            value={staged[t.value] ?? ""}
            onChange={(url) =>
              setStaged((prev) => {
                const next = { ...prev };
                if (url) next[t.value] = url;
                else delete next[t.value];
                return next;
              })
            }
          />
        ))}
      </ul>

      <Button
        type="button"
        size="sm"
        className="w-full"
        onClick={() => void onSubmit()}
        disabled={busy || stagedTypes.length === 0}
      >
        {busy
          ? "Submitting…"
          : stagedTypes.length <= 1
            ? "Submit document"
            : `Submit ${stagedTypes.length} documents`}
      </Button>
    </div>
  );
}

/** One document type's upload slot. */
function KycSlot({
  type,
  label,
  value,
  onChange,
}: {
  type: KycDocumentType;
  label: string;
  value: string;
  onChange: (url: string) => void;
}) {
  const captureMode = CAMERA_MODE[type];
  return (
    <li className="flex items-center gap-2 rounded border border-default bg-surface-2 px-2 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="text-xs truncate">{label}</div>
        <div className="text-[10px] text-fg-subtle">
          {captureMode === "user"
            ? "Selfie — camera or file"
            : captureMode === "environment"
              ? "Photo or file"
              : "PDF or image"}
        </div>
      </div>
      <FileUpload
        subdir="kyc"
        value={value || null}
        onUploaded={onChange}
        onClear={() => onChange("")}
        capture={captureMode}
        label="Choose file"
      />
    </li>
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
