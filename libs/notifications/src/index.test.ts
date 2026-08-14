import { describe, expect, it } from "vitest";

import { MockNotificationProvider, maskRecipient } from "./index";

describe("the mock provider does not log what it sends", () => {
  /*
   * A regression guard on a live privacy leak, not a style preference.
   * This provider is the terminus of EVERY notification path — the tenant
   * Twilio and SendGrid builders discard their config and return a mock,
   * and neither SDK is in any package.json — so whatever it prints, it
   * prints in production too, on stdout, bypassing pino's redact rules.
   *
   * The bodies carry borrower name, outstanding balance and due date, plus
   * password-reset links and co-maker consent tokens. A reset link on
   * stdout is a live credential (§57, §71).
   */
  it("logs neither the recipient nor the body", async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => void lines.push(args.join(" "));
    try {
      await new MockNotificationProvider().send({
        channel: "EMAIL",
        recipient: "juan.delacruz@example.com",
        subject: "Payment due",
        body: "Dear Juan Dela Cruz, loan LN-1 has 12,345.67 due on 2026-09-01. Reset: https://x/y?token=SECRET",
      });
    } finally {
      console.log = original;
    }

    const logged = lines.join("\n");
    expect(logged).not.toContain("juan.delacruz@example.com");
    expect(logged).not.toContain("Juan Dela Cruz");
    expect(logged).not.toContain("12,345.67");
    expect(logged).not.toContain("SECRET");
    // Still useful: you can tell an email went out, and roughly where.
    expect(logged).toContain("@example.com");
  });

  it("masks a mobile number without hiding that one was used", () => {
    expect(maskRecipient("+639171234567")).not.toContain("9171234");
    expect(maskRecipient("+639171234567")).toContain("+6391");
  });
});
