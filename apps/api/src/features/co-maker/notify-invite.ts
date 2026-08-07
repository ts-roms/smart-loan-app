/**
 * Delivering a co-maker's invite link.
 *
 * SMS first, email as the fallback. Phone is required on a co-maker
 * and email isn't, so SMS is the only channel guaranteed to have an
 * address — and a co-maker is typically a parent or an employer who
 * reads texts rather than checking a mailbox for a lender they have
 * no account with.
 *
 * Best-effort by design. A provider outage must not cost the officer
 * the link: the endpoint returns the URL regardless, and the outcome
 * reported here is what tells the UI whether to say "sent" or "copy
 * this and send it yourself".
 */

import type { CoMaker, NotificationRepository, PrismaClient } from "@loan/db";
import { formatMoney } from "@loan/shared-utils";

export type InviteDelivery =
  | { sent: true; channel: "SMS" | "EMAIL"; recipient: string }
  | { sent: false; reason: "NoContact" | "Failed" };

interface Logger {
  warn: (obj: unknown, msg?: string) => void;
}

function roleLabel(role: string): string {
  return role === "CO_BORROWER"
    ? "a co-borrower"
    : role === "GUARANTOR"
      ? "a guarantor"
      : "a co-maker";
}

export async function sendCoMakerInvite(args: {
  prisma: PrismaClient;
  notifications: NotificationRepository;
  coMaker: CoMaker;
  url: string;
  log: Logger;
}): Promise<InviteDelivery> {
  const { prisma, notifications, coMaker, url, log } = args;

  const channel: "SMS" | "EMAIL" | null = coMaker.phone
    ? "SMS"
    : coMaker.email
      ? "EMAIL"
      : null;
  if (!channel) return { sent: false, reason: "NoContact" };
  const recipient = channel === "SMS" ? coMaker.phone : coMaker.email!;

  const loan = await prisma.loanApplication.findUnique({
    where: { id: coMaker.loanId },
    select: {
      // The number, so the invite links to the loan it is about rather
      // than to the borrower's profile. See `notificationLink`.
      number: true,
      principal: true,
      customer: { select: { id: true, firstName: true, lastName: true } },
    },
  });
  const company = await prisma.systemConfig.findFirst({
    select: { companyName: true },
  });

  try {
    await notifications.dispatch({
      event: "CO_MAKER_INVITED",
      channel,
      recipient,
      data: {
        coMakerName: coMaker.fullName,
        borrowerName: loan
          ? `${loan.customer.firstName} ${loan.customer.lastName}`.trim()
          : "A borrower",
        roleLabel: roleLabel(coMaker.role),
        // `amountLabel`, not `amount`: the shared TemplateData types
        // `amount` as a number and the renderer interpolates it
        // verbatim, so every other template says "50000". Formatting
        // it centrally would reword every existing notification, which
        // is a bigger change than this one should carry.
        amountLabel: loan ? formatMoney(Number(loan.principal)) : "",
        companyName: company?.companyName ?? "your lender",
        url,
      },
      refType: "CoMaker",
      refId: coMaker.id,
      refNumber: loan?.number,
      // Linked to the BORROWER's customer record, not the co-maker —
      // a co-maker isn't a customer, and this belongs on the timeline
      // of the loan it concerns.
      customerId: loan?.customer.id,
    });
    return { sent: true, channel, recipient };
  } catch (err) {
    log.warn({ err, coMakerId: coMaker.id }, "co-maker invite send failed");
    return { sent: false, reason: "Failed" };
  }
}
