/**
 * Notification dispatcher + persistence.
 *
 * Each `dispatch()` call:
 *   1. Renders the template for the (event, channel).
 *   2. Creates a `Notification` row in QUEUED state.
 *   3. Calls the provider's send().
 *   4. Updates the row to SENT (with providerRef) or FAILED (with error).
 *
 * Failures are swallowed — a downed SMS provider should not block the loan
 * disburse it was notifying about. Operators see the failures in the inbox.
 */

import {
  type Channel,
  type NotificationEvent,
  type NotificationProvider,
  type TemplateData,
  renderTemplate,
} from "@loan/notifications";
import type { Notification, PrismaClient } from "@prisma/client";

export interface DispatchInput {
  event: NotificationEvent;
  channel: Channel;
  recipient: string;
  data: TemplateData;
  refType?: string;
  refId?: string;
  /**
   * The human reference the rendered message quotes — "LN-2026-000006".
   * For a notification ABOUT a loan but keyed on something else (an
   * instalment, a lease, an annual document) this is the LOAN's number,
   * because that is what the message names and where the reader expects
   * to land.
   */
  refNumber?: string;
  customerId?: string;
}

export class NotificationRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly provider: NotificationProvider,
  ) {}

  list(filter?: {
    customerId?: string;
    event?: NotificationEvent;
    status?: "QUEUED" | "SENT" | "FAILED";
    take?: number;
  }): Promise<Notification[]> {
    return this.prisma.notification.findMany({
      where: {
        customerId: filter?.customerId,
        event: filter?.event as never,
        status: filter?.status as never,
      },
      orderBy: { createdAt: "desc" },
      take: filter?.take ?? 100,
    });
  }

  async dispatch(input: DispatchInput): Promise<Notification> {
    const rendered = renderTemplate({
      event: input.event,
      channel: input.channel,
      data: input.data,
    });

    let row = await this.prisma.notification.create({
      data: {
        event: input.event as never,
        channel: input.channel,
        recipient: input.recipient,
        subject: rendered.subject,
        body: rendered.body,
        refType: input.refType,
        refNumber: input.refNumber,
        refId: input.refId,
        customerId: input.customerId,
        status: "QUEUED",
      },
    });

    try {
      const result = await this.provider.send({
        channel: input.channel,
        recipient: input.recipient,
        subject: rendered.subject,
        body: rendered.body,
      });
      row = await this.prisma.notification.update({
        where: { id: row.id },
        data: {
          status: "SENT",
          sentAt: new Date(),
          providerRef: result.providerRef,
        },
      });
    } catch (err) {
      row = await this.prisma.notification.update({
        where: { id: row.id },
        data: {
          status: "FAILED",
          error: (err as Error).message,
        },
      });
    }
    return row;
  }
}
