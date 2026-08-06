import {
  useInviteCoMaker,
  useLoanCoMakers,
  useRevokeCoMakerInvite,
} from "@loan/api-client";
import { formatDateTime } from "@loan/shared-utils";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  SkeletonCard,
  cn,
  useConfirm,
  useToast,
} from "@loan/ui";
import {
  Copy,
  Link2Off,
  MailOpen,
  MailWarning,
  Send,
  UserPlus,
  Users,
} from "lucide-react";

import { useState } from "react";

import { DocumentThumbnail } from "../../../components/DocumentPreview";
import { AddCoMakerDialog } from "./AddCoMakerDialog";
import { usePermission } from "../../../hooks/use-permission";
import { DOC_TYPE_LABELS } from "../../customers/constants";

/**
 * Co-makers and where each one stands.
 *
 * A co-maker is jointly liable, so their agreement is a decision they
 * make rather than a box the officer ticks — and disbursement is
 * blocked until every one of them has approved. This panel is where
 * the officer sees who is holding that up and sends them a link.
 *
 * Inviting sends the link by SMS (or email when there's no number)
 * and copies it too — a sent link is still worth having on the
 * clipboard when the co-maker rings back saying it never arrived.
 * Delivery is best-effort, so the toast says which actually happened.
 */
export function CoMakersPanel({
  loanId,
  borrowerId,
}: {
  loanId: string;
  /**
   * Excluded from the add picker. Passing it in rather than reading the
   * loan again keeps this panel a leaf — the detail page already has it.
   */
  borrowerId: string;
}) {
  const [adding, setAdding] = useState(false);
  const coMakers = useLoanCoMakers(loanId);
  const invite = useInviteCoMaker();
  const revoke = useRevokeCoMakerInvite();
  const toast = useToast();
  const confirm = useConfirm();
  // Same key as the staff-side force logout. A co-maker has no session
  // to end — the link IS the access — so cutting it off is the same
  // administrative act and answers to the same permission.
  const canRevoke = usePermission("admin.force_logout");
  // Same key the API gates the create endpoint on.
  const canAdd = usePermission("loans.apply");

  const rows = coMakers.data ?? [];
  if (coMakers.isLoading) return <SkeletonCard />;
  /*
   * Renders even with no co-makers now. It used to return null, which
   * meant the only way to add one was during the new-loan wizard — a
   * loan that turned out to need a guarantor had nowhere to say so.
   */

  const blocking = rows.filter((c) => c.status !== "APPROVED");

  const sendInvite = async (id: string, name: string) => {
    try {
      const { url, delivery } = await invite.mutateAsync(id);
      // Copy regardless: even a sent link is worth having on the
      // clipboard when the co-maker rings back saying it never came.
      await navigator.clipboard.writeText(url).catch(() => {});
      if (delivery.sent) {
        toast.success(
          `Sent to ${name} by ${delivery.channel === "SMS" ? "SMS" : "email"} (${delivery.recipient}). Link also copied.`,
        );
      } else {
        toast.info(
          delivery.reason === "NoContact"
            ? `${name} has no phone or email on file — link copied, send it yourself.`
            : `Couldn't send automatically — link copied, send it to ${name}.`,
        );
      }
    } catch (err) {
      toast.error((err as Error).message ?? "Could not create a link");
    }
  };

  /**
   * Kill a co-maker's link.
   *
   * The dialog is explicit that their answer survives, because the
   * obvious guess is the opposite — "revoke" reads like undoing the
   * consent, and an officer who believed that would think they'd
   * unblocked disbursement when they hadn't.
   */
  const revokeInvite = async (id: string, name: string) => {
    const ok = await confirm({
      title: `Revoke ${name}'s link?`,
      message:
        "Their consent link stops working immediately. Any answer they've already given stays on the record, and disbursement is still gated on it. You can send a new link at any time.",
      confirmLabel: "Revoke link",
      tone: "destructive",
    });
    if (!ok) return;
    try {
      const res = await revoke.mutateAsync(id);
      toast.success(
        res.hadActiveLink
          ? `${name}'s link is dead`
          : `${name} had no live link — nothing to revoke`,
      );
    } catch (err) {
      toast.error((err as Error).message ?? "Could not revoke the link");
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Users className="h-4 w-4" />
          Co-makers
        </CardTitle>
        <div className="flex items-center gap-2">
          {blocking.length > 0 && (
            <Badge variant="warning">
              {blocking.length} blocking disbursement
            </Badge>
          )}
          {canAdd && (
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              <UserPlus className="h-3 w-3" />
              Add
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.length === 0 && (
          <p className="text-xs text-fg-muted">
            No co-makers on this loan. Adding one brings a second party&apos;s
            capacity to the debt — and their approval before disbursement.
          </p>
        )}
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
                  {/*
                    Only while an answer is outstanding. Once they've
                    responded, whether they opened the link first is
                    archaeology — the answer is the fact that matters.
                    Before then it's the whole diagnosis, and it decides
                    the officer's next move: chase the person, or chase
                    the number.
                  */}
                  {!c.respondedAt && c.inviteSentAt && (
                    <div
                      className={cn(
                        "mt-0.5 inline-flex items-center gap-1 text-[10px]",
                        c.linkOpenedAt ? "text-info" : "text-warning",
                      )}
                    >
                      {c.linkOpenedAt ? (
                        <>
                          <MailOpen className="h-3 w-3 shrink-0" />
                          Opened {formatDateTime(c.linkOpenedAt)} — seen, not
                          yet answered
                        </>
                      ) : (
                        <>
                          <MailWarning className="h-3 w-3 shrink-0" />
                          Never opened — the link may not have reached them
                        </>
                      )}
                    </div>
                  )}
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
                {/* Only where there's something to revoke. A co-maker
                    who was never invited has no link to kill, and the
                    button would just be a question mark. */}
                {canRevoke && c.inviteSentAt && (
                  <Button
                    size="sm"
                    variant="outline"
                    loading={revoke.isPending && revoke.variables === c.id}
                    onClick={() => void revokeInvite(c.id, c.fullName)}
                    title="Stop this co-maker's link from working"
                  >
                    {!revoke.isPending && <Link2Off className="h-3 w-3" />}
                    Revoke
                  </Button>
                )}
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
        {adding && (
          <AddCoMakerDialog
            loanId={loanId}
            borrowerId={borrowerId}
            existingCustomerIds={rows
              .map((c) => c.customerId)
              .filter((id): id is string => Boolean(id))}
            onClose={() => setAdding(false)}
          />
        )}
        {rows.length > 0 && (
          <p className="text-[10px] text-fg-subtle">
            Invites go out by SMS, or email when there&apos;s no number. The
            link is copied to your clipboard either way. Sending a new one
            cancels the previous link and clears any answer already given.
          </p>
        )}
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
