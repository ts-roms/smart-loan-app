/**
 * Provider factories — pick the right implementation of each external
 * dependency based on env config. Returns the same interface either way
 * so callers don't branch.
 *
 * Today every real provider is a TODO that falls back to its mock; the
 * factory shape is in place so wiring a real one later is a single-file
 * change.
 *
 * Pattern:
 *   const provider = createNotificationProvider(config.notificationProvider);
 *   const repo = new NotificationRepository(prisma, provider);
 *
 * Note: payments has its own factory at @loan/payments.buildProvider —
 * it already does env-driven GCash/Maya/Mock selection and is consumed
 * by routes/payments.ts. We don't duplicate it here.
 */

import type { AmlProviderName, NotificationProviderName } from "./config";
import {
  MockNotificationProvider,
  type NotificationProvider,
} from "@loan/notifications";
import { MockAmlProvider, type AmlProvider } from "@loan/screening";

/**
 * Notification provider factory. Switch on env at boot; the result is a
 * single instance held for the life of the process.
 *
 * Wiring a real provider:
 *   1. Add a class implementing NotificationProvider in @loan/notifications
 *      (e.g. SendGridProvider).
 *   2. Add the case below.
 *   3. Document the required env vars in .env.example + config.ts.
 *   4. Set NOTIFICATION_PROVIDER=SENDGRID in the deploy env.
 */
export function createNotificationProvider(
  name: NotificationProviderName,
  log?: { warn: (obj: object, msg: string) => void },
): NotificationProvider {
  switch (name) {
    case "MOCK":
      return new MockNotificationProvider();
    case "SENDGRID":
    case "TWILIO":
    case "SES":
      log?.warn?.(
        {},
        `[providers] NOTIFICATION_PROVIDER=${name} not yet implemented — falling back to MOCK. See providers.ts.`,
      );
      return new MockNotificationProvider();
  }
}

/**
 * AML / sanctions screening provider factory. The MockAmlProvider needs
 * a watchlist loader callback so it can read from the DB-backed
 * AmlWatchlistEntry table.
 */
export function createAmlProvider(
  name: AmlProviderName,
  loadWatchlist: () => Promise<
    Array<{
      list: string;
      fullName: string;
      aliases: string[];
      reason: string | null;
    }>
  >,
  log?: { warn: (obj: object, msg: string) => void },
): AmlProvider {
  switch (name) {
    case "MOCK":
      return new MockAmlProvider(loadWatchlist);
    case "COMPLY_ADVANTAGE":
    case "REFINITIV":
    case "WORLD_CHECK":
      log?.warn?.(
        {},
        `[providers] AML_PROVIDER=${name} not yet implemented — falling back to MOCK. See providers.ts.`,
      );
      return new MockAmlProvider(loadWatchlist);
  }
}
