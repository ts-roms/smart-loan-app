import {
  useDecideKyc,
  useKycForCustomer,
  useLatestScreening,
} from "@loan/api-client";
import type { KycSubmission } from "@loan/shared-types";
import {
  Badge,
  Button,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
  SkeletonLine,
  usePrompt,
  useToast,
} from "@loan/ui";
import { formatDateTime } from "@loan/shared-utils";
import {
  ExternalLink,
  FileCheck2,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

// Direct import — see customers/constants.ts for why.
import { DOC_TYPE_LABELS } from "../../customers/constants";

/**
 * Click-to-inspect wrapper for a customer's KYC pack. Opens a focused
 * review drawer with all documents, the latest AML screening, and inline
 * approve/reject buttons. Used from the KYC queue customer names — the
 * inline list remains for fast triage, the drawer is the deep-review
 * surface.
 *
 * Usage:
 *   <KycInspectorLink customerId={c.id} customerName={fullName}>
 *     {fullName}
 *   </KycInspectorLink>
 */
export function KycInspectorLink({
  customerId,
  customerName,
  children,
}: {
  customerId: string;
  customerName?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <button
          type="button"
          className="text-left hover:text-sky-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60 rounded"
          aria-label="Inspect KYC pack"
        >
          {children}
        </button>
      </DrawerTrigger>
      <DrawerContent>
        <KycInspector customerId={customerId} customerName={customerName} />
      </DrawerContent>
    </Drawer>
  );
}

function KycInspector({
  customerId,
  customerName,
}: {
  customerId: string;
  customerName?: string;
}) {
  const docs = useKycForCustomer(customerId);
  const aml = useLatestScreening(customerId);
  const decide = useDecideKyc();
  const toast = useToast();
  const askPrompt = usePrompt();

  const onDecide = async (
    sub: KycSubmission,
    status: "VERIFIED" | "REJECTED",
  ) => {
    let reason: string | undefined;
    if (status === "REJECTED") {
      const answer = await askPrompt({
        title: "Reject this document?",
        message:
          "The reason is shared with the customer so they can re-submit correctly.",
        label: "Reason",
        placeholder: "e.g. blurry image, expired ID",
        confirmLabel: "Reject",
      });
      if (answer === null) return;
      reason = answer;
    }
    try {
      await decide.mutateAsync({
        id: sub.id,
        customerId,
        status,
        reason,
      });
      toast.success(
        `${DOC_TYPE_LABELS[sub.documentType] ?? sub.documentType} ${status.toLowerCase()}`,
      );
    } catch (err) {
      toast.error((err as Error).message ?? "Failed");
    }
  };

  const items = docs.data ?? [];
  const pendingCount = items.filter((d) => d.status === "PENDING").length;
  const verifiedCount = items.filter((d) => d.status === "VERIFIED").length;
  const rejectedCount = items.filter((d) => d.status === "REJECTED").length;

  return (
    <>
      <DrawerHeader>
        <div className="flex items-start gap-2">
          <FileCheck2 className="h-5 w-5 mt-0.5 text-emerald-300" />
          <div className="flex-1 min-w-0">
            <DrawerTitle>{customerName ?? "KYC pack"}</DrawerTitle>
            <DrawerDescription>
              {items.length} document{items.length === 1 ? "" : "s"} ·{" "}
              <span className="text-amber-300">{pendingCount} pending</span> ·{" "}
              <span className="text-emerald-300">{verifiedCount} verified</span>{" "}
              · <span className="text-rose-300">{rejectedCount} rejected</span>
            </DrawerDescription>
          </div>
        </div>
      </DrawerHeader>

      <DrawerBody>
        {/* AML screening */}
        <div className="rounded-md border border-white/10 bg-white/[0.03] p-2.5">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-white/45 mb-1">
            {aml.data?.status === "CLEAR" ? (
              <ShieldCheck className="h-3 w-3 text-emerald-300" />
            ) : (
              <ShieldAlert className="h-3 w-3 text-amber-300" />
            )}
            AML / sanctions screen
          </div>
          {aml.isLoading ? (
            <SkeletonLine />
          ) : !aml.data ? (
            <p className="text-xs text-white/55">No screening on file.</p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <Badge
                  variant={
                    aml.data.status === "CLEAR" ||
                    aml.data.status === "OVERRIDDEN"
                      ? "success"
                      : aml.data.status === "MATCH"
                        ? "danger"
                        : "warning"
                  }
                >
                  {aml.data.status}
                </Badge>
                <span className="text-[10px] text-white/55">
                  {formatDateTime(aml.data.screenedAt)} · {aml.data.provider}
                </span>
              </div>
              {(aml.data.matches?.length ?? 0) > 0 && (
                <ul className="mt-1.5 space-y-1">
                  {aml.data.matches!.map((m, i) => (
                    <li key={i} className="text-[10px] text-white/65">
                      <span className="font-mono">{m.list}</span> ·{" "}
                      {m.matchedName} · score {m.score.toFixed(2)}
                      {m.reason ? ` · ${m.reason}` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        {/* Documents */}
        {docs.isLoading ? (
          <div className="space-y-2">
            <SkeletonLine />
            <SkeletonLine />
          </div>
        ) : items.length === 0 ? (
          <p className="text-sm text-white/55">No documents submitted yet.</p>
        ) : (
          <ul className="rounded-md border border-white/10 bg-white/[0.03] divide-y divide-white/5">
            {items.map((d) => (
              <li key={d.id} className="p-2.5 text-sm">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-medium">
                      {DOC_TYPE_LABELS[d.documentType] ?? d.documentType}
                    </div>
                    <div className="text-[10px] text-white/45 flex items-center gap-1 mt-0.5">
                      {formatDateTime(d.submittedAt)} ·{" "}
                      <a
                        href={d.documentUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sky-300 hover:underline inline-flex items-center gap-0.5"
                      >
                        view <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
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
                </div>
                {d.reason && (
                  <div className="mt-1 text-[10px] text-rose-300">
                    Rejected: {d.reason}
                  </div>
                )}
                {d.status === "PENDING" && (
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" onClick={() => onDecide(d, "VERIFIED")}>
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onDecide(d, "REJECTED")}
                    >
                      Reject
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </DrawerBody>

      <DrawerFooter>
        <Button variant="outline" asChild>
          <Link
            to={`/customers/${customerId}`}
            className="inline-flex items-center gap-1"
          >
            Open customer profile
          </Link>
        </Button>
      </DrawerFooter>
    </>
  );
}
