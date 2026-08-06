import { useKycForCustomer } from "@loan/api-client";
import type { KycDocumentType } from "@loan/shared-types";
import { Badge } from "@loan/ui";
import {
  CheckCircle2,
  Circle,
  ExternalLink,
  FileCheck2,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo } from "react";

// Direct import — see customers/constants.ts for why.
import { DOC_TYPE_LABELS } from "../../customers/constants";
import { KycInspectorLink } from "../../kyc";

/**
 * Same base pack that @loan/kyc's REQUIRED_DOCS enforces server-side.
 * Kept inline (one line, three strings) to avoid pulling the @loan/kyc
 * lib into the web app just for a constant. If underwriting policy
 * tightens, edit both in lockstep.
 */
const BASE_REQUIRED: KycDocumentType[] = [
  "ID_FRONT",
  "PROOF_OF_INCOME",
  "PROOF_OF_ADDRESS",
];

type DocStatus = "VERIFIED" | "PENDING" | "REJECTED" | "MISSING";

export interface KycGapWarningProps {
  customerId: string;
  /**
   * Product-specific required documents — appended to BASE_REQUIRED. Pass
   * the LoanProduct.requiredKycDocs array directly.
   */
  productRequiredDocs: readonly KycDocumentType[];
  /**
   * Called whenever the readiness flag flips. Parent disables submit
   * when this is false.
   */
  onReadinessChange?: (ready: boolean) => void;
}

/**
 * Pre-submit KYC checklist. Computes the gap between (base required +
 * product required) and the customer's verified submissions, rendering
 * each required doc with a green / amber / red dot and a link to the
 * KYC inspector drawer for any missing or rejected docs.
 *
 * Bubbles a `ready` flag up via `onReadinessChange` so the parent can
 * disable submit until every required doc is VERIFIED.
 */
export function KycGapWarning({
  customerId,
  productRequiredDocs,
  onReadinessChange,
}: KycGapWarningProps) {
  const kyc = useKycForCustomer(customerId);

  // Latest decision wins per type. Submissions arrive newest-first from
  // the API; first-seen wins in the map.
  const byType = useMemo(() => {
    const map = new Map<KycDocumentType, DocStatus>();
    for (const s of kyc.data ?? []) {
      if (!map.has(s.documentType)) {
        map.set(s.documentType, s.status);
      }
    }
    return map;
  }, [kyc.data]);

  // Dedupe the union of base + product required so we don't render
  // the same row twice when the product happens to list ID_FRONT.
  const required = useMemo(
    () => Array.from(new Set([...BASE_REQUIRED, ...productRequiredDocs])),
    [productRequiredDocs],
  );

  const rows = required.map((docType) => ({
    docType,
    status: byType.get(docType) ?? "MISSING",
  }));

  const missingCount = rows.filter((r) => r.status === "MISSING").length;
  const rejectedCount = rows.filter((r) => r.status === "REJECTED").length;
  const pendingCount = rows.filter((r) => r.status === "PENDING").length;
  const verifiedCount = rows.filter((r) => r.status === "VERIFIED").length;
  const ready = verifiedCount === rows.length;

  // Surface readiness upward so the dialog can block submit. useEffect
  // (not a derived render-time call) so we don't loop setState updates.
  useEffect(() => {
    onReadinessChange?.(ready);
  }, [ready, onReadinessChange]);

  if (kyc.isLoading) {
    return (
      <div className="rounded-md border border-default bg-surface-2 p-3 text-xs text-fg-muted">
        Checking KYC pack…
      </div>
    );
  }

  // Banner tone reflects the worst-case across all required docs.
  const tone =
    rejectedCount > 0
      ? "bad"
      : missingCount > 0
        ? "warn"
        : pendingCount > 0
          ? "warn"
          : "good";

  const toneClass = {
    good: "border-success/30 bg-success/[0.06]",
    warn: "border-warning/30 bg-warning/[0.06]",
    bad: "border-danger/30 bg-danger/[0.08]",
  }[tone];

  return (
    <div className={`rounded-md border ${toneClass} p-3 space-y-2`}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2 text-sm">
          <FileCheck2 className="h-4 w-4 text-info" />
          <span className="font-medium">KYC checklist</span>
          <span className="text-fg-muted text-xs">
            for this product · {verifiedCount}/{rows.length} verified
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {ready ? (
            <Badge variant="success">
              <CheckCircle2 className="h-3 w-3" />
              Ready to apply
            </Badge>
          ) : (
            <Badge variant={rejectedCount > 0 ? "danger" : "warning"}>
              {missingCount + rejectedCount + pendingCount} doc(s) outstanding
            </Badge>
          )}
          <KycInspectorLink customerId={customerId} customerName="">
            <span className="inline-flex items-center gap-1 text-xs text-info hover:underline">
              Open KYC inspector
              <ExternalLink className="h-3 w-3" />
            </span>
          </KycInspectorLink>
        </div>
      </div>

      <ul className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
        {rows.map(({ docType, status }) => (
          <li
            key={docType}
            className="flex items-center gap-2 rounded border border-default bg-surface-2 px-2 py-1.5 text-xs"
          >
            <StatusIcon status={status} />
            <span className="flex-1 truncate">
              {DOC_TYPE_LABELS[docType] ?? docType}
            </span>
            <span className="text-[10px] uppercase tracking-wider text-fg-subtle">
              {status === "MISSING" ? "Not submitted" : status.toLowerCase()}
            </span>
          </li>
        ))}
      </ul>

      {!ready && (
        <p className="text-[11px] text-fg-muted">
          The application can be drafted now, but{" "}
          <strong className="text-fg">decisioning will be blocked</strong> until
          every required doc is VERIFIED.{" "}
          {rejectedCount > 0 &&
            "Rejected docs must be re-uploaded — check the rejection reason in the inspector."}
        </p>
      )}
    </div>
  );
}

function StatusIcon({ status }: { status: DocStatus }) {
  if (status === "VERIFIED")
    return <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0" />;
  if (status === "PENDING")
    return <Circle className="h-3.5 w-3.5 text-warning shrink-0" />;
  if (status === "REJECTED")
    return <XCircle className="h-3.5 w-3.5 text-danger shrink-0" />;
  return <Circle className="h-3.5 w-3.5 text-fg-subtle shrink-0" />;
}
