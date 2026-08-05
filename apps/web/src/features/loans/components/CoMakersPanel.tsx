import { useInviteCoMaker, useLoanCoMakers } from "@loan/api-client";
import { formatDateTime } from "@loan/shared-utils";
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
import { Copy, Send, Users } from "lucide-react";

import { DocumentThumbnail } from "../../../components/DocumentPreview";
import { DOC_TYPE_LABELS } from "../../customers/constants";

/**
 * Co-makers and where each one stands.
 *
 * A co-maker is jointly liable, so their agreement is a decision they
 * make rather than a box the officer ticks — and disbursement is
 * blocked until every one of them has approved. This panel is where
 * the officer sees who is holding that up and sends them a link.
 *
 * The link is copied rather than sent: who delivers it — SMS, email,
 * or the officer reading it out over the phone — isn't settled, and a
 * copyable link works today under all three.
 */
export function CoMakersPanel({ loanId }: { loanId: string }) {
  const coMakers = useLoanCoMakers(loanId);
  const invite = useInviteCoMaker();
  const toast = useToast();

  const rows = coMakers.data ?? [];
  if (coMakers.isLoading) return <SkeletonCard />;
  if (rows.length === 0) return null;

  const blocking = rows.filter((c) => c.status !== "APPROVED");

  const sendInvite = async (id: string, name: string) => {
    try {
      const { url } = await invite.mutateAsync(id);
      await navigator.clipboard.writeText(url).catch(() => {});
      toast.success(`Link for ${name} copied — send it to them.`);
    } catch (err) {
      toast.error((err as Error).message ?? "Could not create a link");
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Users className="h-4 w-4" />
          Co-makers
        </CardTitle>
        {blocking.length > 0 && (
          <Badge variant="warning">
            {blocking.length} blocking disbursement
          </Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        <ul className="divide-y divide-default">
          {rows.map((c) => (
            <li key={c.id} className="py-2 space-y-1.5">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm truncate">{c.fullName}</div>
                  <div className="text-[10px] text-fg-subtle">
                    {c.phone}
                    {c.respondedAt
                      ? ` · answered ${formatDateTime(c.respondedAt)}`
                      : c.inviteSentAt
                        ? ` · invited ${formatDateTime(c.inviteSentAt)}`
                        : " · not yet invited"}
                  </div>
                </div>
                <StatusBadge status={c.status} />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void sendInvite(c.id, c.fullName)}
                  disabled={invite.isPending}
                >
                  {c.inviteSentAt ? (
                    <>
                      <Copy className="h-3 w-3" />
                      New link
                    </>
                  ) : (
                    <>
                      <Send className="h-3 w-3" />
                      Invite
                    </>
                  )}
                </Button>
              </div>

              {/* Their words, not a summary — the officer's next move
                  depends entirely on why. */}
              {c.status === "DECLINED" && c.declineReason && (
                <div className="rounded border border-danger/30 bg-danger-soft px-2 py-1 text-xs">
                  &ldquo;{c.declineReason}&rdquo;
                </div>
              )}

              {(c.documents ?? []).length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {(c.documents ?? []).map((doc) => (
                    <DocumentThumbnail
                      key={doc.id}
                      url={doc.documentUrl}
                      label={
                        DOC_TYPE_LABELS[doc.documentType] ?? doc.documentType
                      }
                    />
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
        <p className="text-[10px] text-fg-subtle">
          Sending a new link cancels the previous one and clears any answer
          already given.
        </p>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant={
        status === "APPROVED"
          ? "success"
          : status === "DECLINED"
            ? "danger"
            : "warning"
      }
    >
      {status}
    </Badge>
  );
}
