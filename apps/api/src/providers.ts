/**
 * Provider factories — pick the right implementation of each external
 * dependency based on env config. Returns the same interface either way
 * so callers don't branch.
 *
 * SENDGRID and TWILIO are real; SES is still a TODO that falls back to
 * its mock. AML is mock-only.
 *
 * Pattern:
 *   const provider = createNotificationProvider(config.notificationProvider);
 *   const repo = new NotificationRepository(prisma, provider);
 *
 * Note: payments has its own factory at @loan/payments.buildProvider —
 * it already does env-driven GCash/Maya/Mock selection and is consumed
 * by routes/payments.ts. We don't duplicate it here.
 */

import { config } from "./config";
import type { AmlProviderName, NotificationProviderName } from "./config";
import {
  MockNotificationProvider,
  SendGridProvider,
  TwilioProvider,
  type NotificationProvider,
} from "@loan/notifications";
import { MockAmlProvider, type AmlProvider } from "@loan/screening";

/**
 * Notification provider factory. Switch on env at boot; the result is a
 * single instance held for the life of the process.
 *
 * The credential checks here are a floor, not the gate. `validateConfig`
 * already refuses to boot in production when a named provider's
 * credentials are missing, and refuses MOCK in production outright. This
 * function has to stay total for development, where an operator may have
 * set the provider name before pasting the keys — so it degrades to the
 * mock with a warning rather than throwing, and production never reaches
 * that branch because boot already failed.
 *
 * Wiring another provider:
 *   1. Add a class implementing NotificationProvider in @loan/notifications.
 *   2. Add the case below.
 *   3. Document the required env vars in .env.example + config.ts, and add
 *      them to `expectedNotificationCreds`.
 *   4. Remove it from the `unimplemented` list in validateConfig.
 */
export function createNotificationProvider(
  name: NotificationProviderName,
  log?: { warn: (obj: object, msg: string) => void },
): NotificationProvider {
  switch (name) {
    case "MOCK":
      return new MockNotificationProvider();

    case "SENDGRID": {
      if (!config.sendgridApiKey || !config.sendgridFromEmail) {
        return degrade(name, "SENDGRID_API_KEY + SENDGRID_FROM_EMAIL", log);
      }
      return new SendGridProvider({
        apiKey: config.sendgridApiKey,
        fromEmail: config.sendgridFromEmail,
        fromName: config.sendgridFromName || undefined,
        timeoutMs: config.notificationTimeoutMs,
      });
    }

    case "TWILIO": {
      if (
        !config.twilioAccountSid ||
        !config.twilioAuthToken ||
        !config.twilioFromPhone
      ) {
        return degrade(
          name,
          "TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM_PHONE",
          log,
        );
      }
      return new TwilioProvider({
        accountSid: config.twilioAccountSid,
        authToken: config.twilioAuthToken,
        fromNumber: config.twilioFromPhone,
        timeoutMs: config.notificationTimeoutMs,
      });
    }

    case "SES":
      log?.warn?.(
        {},
        `[providers] NOTIFICATION_PROVIDER=${name} not yet implemented — falling back to MOCK. See providers.ts.`,
      );
      return new MockNotificationProvider();
  }
}

/**
 * Development-only fallback. Never reached in production: `validateConfig`
 * turns the same missing-credential condition into a refusal to boot.
 */
function degrade(
  name: string,
  needed: string,
  log?: { warn: (obj: object, msg: string) => void },
): NotificationProvider {
  log?.warn?.(
    {},
    `[providers] NOTIFICATION_PROVIDER=${name} but ${needed} not set — ` +
      "falling back to MOCK, which delivers nothing. " +
      "This is a hard failure in production; see config.ts.",
  );
  return new MockNotificationProvider();
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
