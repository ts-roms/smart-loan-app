import { useDecideKyc, useKycPending } from "@loan/api-client";
import type { PendingKycRow } from "@loan/shared-types";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Pagination,
  SkeletonCard,
  usePrompt,
  useToast,
} from "@loan/ui";
import { formatDateTime } from "@loan/shared-utils";
import { FileCheck2 } from "lucide-react";
import { useState } from "react";

// Direct import — pulling DOC_TYPE_LABELS via the customers barrel
// would drag the CustomerDetail page chunk into the kyc chunk and
// trip Rollup's circular-chunk warning.
import { DocumentThumbnail } from "../../../components/DocumentPreview";
import { usePermission } from "../../../hooks/use-permission";
import { DOC_TYPE_LABELS } from "../../customers/constants";
import { KycInspectorLink } from "../components/KycInspectorDrawer";
import { findArticle, TourButton } from "../../help";

/**
 * KYC review queue — documents waiting on a decision.
 *
 * One paginated request, joined to the customer server-side. It used to
 * fetch the customer pool, filter it in the browser, and then issue a
 * request PER customer to find out whether they had anything pending:
 * up to two hundred round trips to render a queue that is usually a
 * handful of rows.
 *
 * It also asked the wrong question. The browser-side filter kept
 * customers whose rollup was NONE — people who had submitted nothing at
 * all — so the queue was padded with rows that cost a request each to
 * prove they had no documents to review. And because the customer pool
 * is capped, a pending document belonging to the two-hundred-and-first
 * customer was invisible with nothing on screen to say so.
 *
 * Oldest first: a review queue is worked front to back, and the document
 * that has waited longest is the one to look at next.
 */

/** Matches the server's `KYC_QUEUE_PAGING.defaultPageSize`. */
const PAGE_SIZE = 20;

export function KycReviewPage() {
  const [page, setPage] = useState(1);
  const queue = useKycPending({ page, pageSize: PAGE_SIZE });
  const data = queue.data;
  const rows = data?.rows ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <FileCheck2 className="h-4 w-4 text-success" />
          KYC review queue
          {data && data.total > 0 && (
            <Badge variant="warning">{data.total} waiting</Badge>
          )}
        </CardTitle>
        <TourButton tourId="kyc" steps={findArticle("kyc")?.tour ?? []} />
      </CardHeader>
      <CardContent className="space-y-3">
        {queue.isLoading ? (
          <SkeletonCard />
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-fg-muted">
            Nothing waiting for review.
          </p>
        ) : (
          <div className="space-y-2" data-tour="kyc-queue">
            {rows.map((row) => (
              <PendingDocument key={row.id} row={row} />
            ))}
          </div>
        )}

        {data && rows.length > 0 && (
          <Pagination
            page={data.page}
            totalPages={data.totalPages}
            total={data.total}
            pageSize={data.pageSize}
            onPageChange={setPage}
            noun="document"
            busy={queue.isFetching}
          />
        )}
      </CardContent>
    </Card>
  );
}

function PendingDocument({ row }: { row: PendingKycRow }) {
  /*
   * The queue opens on `kyc.read`; approving or rejecting needs
   * `kyc.decide`. They coincide across the seeded roles today, but a
   * custom role granted read alone would otherwise see two buttons that
   * answer 403.
   */
  const canDecide = usePermission("kyc.decide");
  const decide = useDecideKyc();
  const toast = useToast();
  const askPrompt = usePrompt();

  const label = DOC_TYPE_LABELS[row.documentType] ?? row.documentType;

  const onDecide = async (status: "VERIFIED" | "REJECTED") => {
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
        id: row.id,
        customerId: row.customerId,
        status,
        reason,
      });
      toast.success(`${label} ${status.toLowerCase()}`);
    } catch (err) {
      toast.error((err as Error).message ?? "Failed");
    }
  };

  return (
    <div className="flex items-center gap-3 rounded-md border border-default bg-surface-2 p-3">
      <DocumentThumbnail url={row.documentUrl} label={label} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{label}</div>
        <div className="truncate text-xs">
          <KycInspectorLink
            customerId={row.customerId}
            customerNumber={row.customerNumber}
            customerName={row.customerName}
          >
            <span className="text-info hover:underline">
              {row.customerName}
            </span>
          </KycInspectorLink>
          <span className="text-fg-subtle">
            {" "}
            · {row.customerNumber} · {row.customerPhone}
          </span>
        </div>
        <div className="text-[11px] text-fg-subtle">
          Submitted {formatDateTime(row.submittedAt)}
        </div>
      </div>
      {canDecide && (
        <div className="flex shrink-0 gap-2">
          <Button
            size="sm"
            onClick={() => void onDecide("VERIFIED")}
            loading={decide.isPending}
          >
            Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void onDecide("REJECTED")}
          >
            Reject
          </Button>
        </div>
      )}
    </div>
  );
}
