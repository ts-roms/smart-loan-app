import type { PrismaClient } from "@loan/db";
import type { NotificationProvider } from "@loan/notifications";
import type { FastifyBaseLogger } from "fastify";
import { createHash, randomBytes } from "node:crypto";

import type { PlatformService } from "../platform/platform.service";
import type { CaptureLeadInput, SignupTenantInput } from "./schemas";

/**
 * Service for the anonymous /public/* surface. Currently houses lead
 * capture from the marketing site; will grow to handle self-service
 * SaaS signup once Phase 2.2 (provisioning runner) lands.
 *
 * Lives in `public` schema (Lead table), not per-tenant — leads
 * exist before any Tenant does.
 */

export type CaptureLeadResult =
  | { ok: true; leadId: string }
  | { ok: false; kind: "DuplicateRecent"; message: string };

/**
 * Signup step 1 — recorded, email sent, nothing provisioned. The
 * response deliberately carries no token: the whole point is that only
 * someone reading that inbox can continue.
 */
export type RequestSignupResult =
  | { ok: true; adminEmail: string; expiresAt: string }
  | {
      ok: false;
      kind: "ModeDisabled" | "SlugTaken";
      message: string;
    };

export type ConfirmSignupResult =
  | {
      ok: true;
      slug: string;
      name: string;
      adminEmail: string;
      /**
       * Shown to the user exactly once, on the signup confirmation.
       * Not recoverable afterwards — the seeder only ever returns it
       * here, and it's stored hashed.
       */
      bootstrapPassword: string | null;
      /**
       * False when license issuance was skipped or failed (typically
       * no signing key on this host). The tenant still works; licensed
       * features answer 402 until an operator issues a token by hand.
       */
      licensed: boolean;
    }
  | {
      ok: false;
      kind:
        | "ModeDisabled"
        | "InvalidToken"
        | "Expired"
        | "AlreadyUsed"
        | "SlugTaken"
        | "ProvisioningFailed";
      message: string;
    };

/**
 * How long a self-serve trial license runs before it has to be
 * renewed by the vendor. Long enough for a cooperative to evaluate
 * with real data, short enough that abandoned signups stop consuming
 * licensed features.
 */
const TRIAL_DAYS = 30;

/**
 * How long a confirmation link stays valid. Long enough to survive a
 * signup at the end of a working day, short enough that an address
 * which later changes hands can't be used to claim a stale signup.
 */
const CONFIRM_TTL_HOURS = 24;

/** SHA-256, matching how RefreshToken hashes its secrets. */
function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export class PublicService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly log: FastifyBaseLogger,
    /**
     * Provisioning is the platform console's job — reusing its service
     * means self-serve signup and vendor-driven provisioning run the
     * exact same schema-create / migrate / seed path, and both land in
     * the platform audit log. A second implementation here would drift.
     */
    private readonly platform: PlatformService,
    /**
     * Platform-level notification provider — NOT the tenant-aware
     * wrapper the rest of the app uses. The confirmation email goes out
     * before any tenant exists, so there is no SystemConfig to read and
     * no tenant schema to persist a Notification row into.
     *
     * Today every provider in this codebase resolves to a mock that
     * logs (see providers.ts), which means the confirmation link
     * appears in the API console and nowhere else. The gate is real
     * regardless: provisioning cannot happen without the token. Wiring
     * a real provider makes the link reach actual inboxes with no
     * change here.
     */
    private readonly notifications: NotificationProvider,
    /** Base URL for the confirmation link — the marketing site. */
    private readonly marketingOrigin: string,
  ) {}

  /**
   * Persist a marketing lead. Returns `DuplicateRecent` when the same
   * email has submitted within the last 5 minutes — a soft dedup
   * that catches double-clicks and refreshes without needing a
   * captcha. Sales can re-engage genuine duplicates manually via the
   * platform console.
   */
  async captureLead(args: {
    input: CaptureLeadInput;
  }): Promise<CaptureLeadResult> {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    const recent = await this.prisma.lead.findFirst({
      where: {
        email: args.input.email,
        createdAt: { gte: fiveMinAgo },
      },
      select: { id: true },
    });
    if (recent) {
      return {
        ok: false,
        kind: "DuplicateRecent",
        message:
          "We already received your message — give us a moment to respond before sending another.",
      };
    }

    const row = await this.prisma.lead.create({
      data: {
        name: args.input.name.trim(),
        email: args.input.email.trim().toLowerCase(),
        cooperative: args.input.cooperative.trim(),
        memberCount: args.input.memberCount,
        deploymentInterest: args.input.deploymentInterest,
        message: args.input.message?.trim(),
        source: args.input.source ?? "contact-form",
      },
    });

    this.log.info(
      {
        leadId: row.id,
        cooperative: row.cooperative,
        deploymentInterest: row.deploymentInterest,
      },
      "[public] new lead",
    );

    return { ok: true, leadId: row.id };
  }

  /**
   * Signup step 1 — record the request and email a confirmation link.
   * Provisions nothing.
   *
   * Everything expensive happens in `confirmTenantSignup`, behind a
   * token that only reaches the address supplied. Without this split,
   * an anonymous POST would create a Postgres schema, run every
   * migration against it, seed it, and mint an admin whose password is
   * shown exactly once — so a mistyped address left a live tenant
   * nobody could reach and nobody cleaned up.
   *
   * The response says nothing about whether the address exists or
   * already signed up, and carries no token. It is the same for every
   * caller who gets this far.
   */
  async requestTenantSignup(args: {
    input: SignupTenantInput;
  }): Promise<RequestSignupResult> {
    if (!isMultiTenantMode()) return modeDisabled();

    const slug = args.input.slug.toLowerCase();
    const adminEmail = args.input.adminEmail.trim().toLowerCase();

    // Checked here purely so the form can say "pick another name"
    // straight away. It's re-checked at confirm time, because between
    // now and then someone else may take it — this check is a
    // courtesy, not a reservation.
    const taken = await this.prisma.tenant.findUnique({ where: { slug } });
    if (taken) {
      return {
        ok: false,
        kind: "SlugTaken",
        message: `The name "${slug}" is already taken. Try another.`,
      };
    }

    // 32 bytes from the CSPRNG. Only the hash is stored, so a database
    // leak yields nothing usable — the plaintext exists in the email
    // and in the response to nobody.
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + CONFIRM_TTL_HOURS * 60 * 60 * 1000);

    await this.prisma.pendingTenantSignup.create({
      data: {
        slug,
        name: args.input.name.trim(),
        adminEmail,
        adminName: args.input.adminName.trim(),
        tokenHash: hashToken(token),
        expiresAt,
      },
    });

    const confirmUrl = `${this.marketingOrigin}/signup/confirm?token=${token}`;
    await this.notifications
      .send({
        channel: "EMAIL",
        recipient: adminEmail,
        subject: `Confirm your SmartLoan workspace: ${args.input.name.trim()}`,
        body: [
          `Hi ${args.input.adminName.trim()},`,
          "",
          `Confirm this address to finish setting up "${args.input.name.trim()}".`,
          "Nothing has been created yet — your workspace is built when you click:",
          "",
          confirmUrl,
          "",
          `The link expires in ${CONFIRM_TTL_HOURS} hours. If you didn't request this, ignore it — no account exists and none will be created.`,
        ].join("\n"),
      })
      .catch((err: unknown) => {
        // Don't fail the request: the row is written and the link is
        // reproducible by requesting again. Failing here would also
        // tell an anonymous caller whether delivery succeeded, which
        // is a small address-probing oracle.
        this.log.error({ slug, err }, "[public] confirmation email failed");
      });

    this.log.info(
      { slug, expiresAt },
      "[public] signup requested, awaiting email confirmation",
    );

    return { ok: true, adminEmail, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Signup step 2 — redeem the token and actually provision.
   *
   * This is by far the heaviest anonymous endpoint in the system: a
   * Postgres schema, the full migration set, seed data, and an admin
   * account. It now requires possession of a token that was only ever
   * sent to the address being verified, which is the real control; the
   * per-IP rate limit remains as a volume bound.
   */
  async confirmTenantSignup(args: {
    token: string;
  }): Promise<ConfirmSignupResult> {
    if (!isMultiTenantMode()) return modeDisabled();

    const pending = await this.prisma.pendingTenantSignup.findUnique({
      where: { tokenHash: hashToken(args.token) },
    });
    // Unknown token. Same message whether it never existed or was
    // garbage — there's nothing to distinguish for a caller who has
    // neither.
    if (!pending) {
      return {
        ok: false,
        kind: "InvalidToken",
        message: "That confirmation link isn't valid. Try signing up again.",
      };
    }
    if (pending.consumedAt) {
      return {
        ok: false,
        kind: "AlreadyUsed",
        message:
          "That link has already been used. Your workspace exists — sign in, or use forgot-password if you've lost the credentials.",
      };
    }
    if (pending.expiresAt.getTime() < Date.now()) {
      return {
        ok: false,
        kind: "Expired",
        message: "That confirmation link has expired. Please sign up again.",
      };
    }

    /**
     * Claim the token before doing any work, conditional on it still
     * being unclaimed. Two clicks in quick succession — a double-click,
     * a mail client prefetch, a retry — would otherwise both pass the
     * checks above and provision twice: two schemas, two admins, one
     * of each pair unreachable.
     *
     * The trade-off is that a provisioning failure burns the token.
     * That's the right way round: a burnt token is a support request,
     * whereas a duplicate tenant is silent corruption.
     */
    const claimed = await this.prisma.pendingTenantSignup.updateMany({
      where: { id: pending.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (claimed.count === 0) {
      return {
        ok: false,
        kind: "AlreadyUsed",
        message: "That link has already been used.",
      };
    }

    const slug = pending.slug;

    // The actor recorded against every audit row this produces. Not a
    // PlatformUser — nobody at the vendor authorised it — so it's a
    // synthetic id that reads unambiguously in the log, paired with
    // the signer's own email so the trail leads back to a person.
    const actor = { id: "self-serve-signup", email: pending.adminEmail };

    // provisionTenant does its own slug check, which is the one that
    // matters — the courtesy check at request time was up to 24 hours
    // ago and reserved nothing, so someone else may have taken the name
    // in between.
    const provisioned = await this.platform.provisionTenant({
      input: {
        slug,
        name: pending.name,
        adminEmail: actor.email,
        adminName: pending.adminName,
      },
      actor,
    });

    if (!provisioned.ok) {
      // SlugTaken is the user's problem and they can fix it by picking
      // another name; RepoError is ours, and the message would leak a
      // database error to an anonymous caller.
      if (provisioned.kind === "SlugTaken") {
        return {
          ok: false,
          kind: "SlugTaken",
          message: `The name "${slug}" was taken while you were confirming. Please sign up again with a different one.`,
        };
      }
      this.log.error(
        { slug, message: provisioned.message },
        "[public] signup failed to create the tenant row",
      );
      return {
        ok: false,
        kind: "ProvisioningFailed",
        message: "We couldn't create your workspace. Please try again shortly.",
      };
    }

    // provisionTenant returns ok:true even when the schema work failed
    // — the catalog row exists and the vendor can retry it. For a
    // self-serve signup there's nobody to do that retry, so treat a
    // tenant still in PROVISIONING as a failure the caller must see.
    if (provisioned.tenant.status !== "ACTIVE") {
      this.log.error(
        { slug },
        "[public] self-serve signup left tenant in PROVISIONING",
      );
      return {
        ok: false,
        kind: "ProvisioningFailed",
        message:
          "We couldn't finish setting up your workspace. Our team has been notified — please contact us.",
      };
    }

    // Trial license. Best-effort: hosts without a signing key still
    // produce a working tenant, just one where licensed features
    // answer 402 until an operator issues a token. Failing the whole
    // signup over it would throw away a completed provisioning run.
    let licensed = false;
    const license = await this.platform.issueLicense({
      input: {
        tenantSlug: slug,
        tenantName: pending.name,
        tier: "PROFESSIONAL",
        expiresAt: new Date(
          Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000,
        ).toISOString(),
        notes: `Self-serve ${TRIAL_DAYS}-day trial`,
      },
      actor,
    });
    if (license.ok) {
      licensed = true;
    } else {
      this.log.warn(
        { slug, kind: license.kind, message: license.message },
        "[public] signup completed without a trial license",
      );
    }

    // Record the signup as a lead too. Sales wants self-serve tenants
    // in the same list they already work, not in a separate place they
    // have to remember to check.
    await this.prisma.lead
      .create({
        data: {
          name: pending.adminName,
          email: actor.email,
          cooperative: pending.name,
          deploymentInterest: "HOSTED",
          source: "self-serve-signup",
          message: `Self-provisioned tenant "${slug}" (email confirmed).`,
        },
      })
      .catch((err: unknown) => {
        // A lead row is bookkeeping. The tenant is already live and the
        // caller is holding credentials for it; failing here would be
        // reporting failure for something that worked.
        this.log.warn({ slug, err }, "[public] signup lead insert failed");
      });

    // Link the pending row to what it produced, so support can trace a
    // confirmation back to its tenant. Best-effort for the same reason
    // as the lead insert.
    await this.prisma.pendingTenantSignup
      .update({ where: { id: pending.id }, data: { tenantSlug: slug } })
      .catch(() => {});

    this.log.info({ slug, licensed }, "[public] self-serve tenant provisioned");

    return {
      ok: true,
      slug,
      name: pending.name,
      adminEmail: actor.email,
      bootstrapPassword: provisioned.bootstrapPassword ?? null,
      licensed,
    };
  }
}

/**
 * Single-tenant installations have no schema-per-tenant machinery, so
 * provisionTenant would insert a catalog row and stop, handing back
 * credentials for a tenant that doesn't exist. Both signup steps refuse
 * loudly rather than appear to succeed.
 */
function isMultiTenantMode(): boolean {
  return (process.env.MULTI_TENANT ?? "").toLowerCase() === "true";
}

function modeDisabled(): { ok: false; kind: "ModeDisabled"; message: string } {
  return {
    ok: false,
    kind: "ModeDisabled",
    message:
      "This installation doesn't offer hosted signup. Get in touch and we'll set you up.",
  };
}
