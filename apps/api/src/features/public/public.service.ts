import type { PrismaClient } from "@loan/db";
import type { FastifyBaseLogger } from "fastify";

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

export type SignupTenantResult =
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
      kind: "ModeDisabled" | "SlugTaken" | "ProvisioningFailed";
      message: string;
    };

/**
 * How long a self-serve trial license runs before it has to be
 * renewed by the vendor. Long enough for a cooperative to evaluate
 * with real data, short enough that abandoned signups stop consuming
 * licensed features.
 */
const TRIAL_DAYS = 30;

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
   * Provision a cooperative's tenant from the marketing site, with no
   * vendor in the loop.
   *
   * This is by far the heaviest anonymous endpoint in the system: it
   * creates a Postgres schema, runs the full migration set against it,
   * seeds reference data, and mints an admin account. The per-IP rate
   * limit in public.routes.ts is what keeps that from being a free
   * schema-creation API, and it's load-bearing rather than defensive
   * polish.
   *
   * No email verification runs first — a deliberate product decision.
   * The consequence to know about: a typo'd address produces a live
   * tenant whose only admin credentials went nowhere. If verification
   * is added later, the place to gate is here, before `provisionTenant`
   * — everything downstream is already idempotent enough to re-run.
   */
  async signupTenant(args: {
    input: SignupTenantInput;
  }): Promise<SignupTenantResult> {
    // Single-tenant installations have no schema-per-tenant machinery,
    // so provisionTenant would insert a catalog row and stop, handing
    // back credentials for a tenant that doesn't exist. Refuse loudly
    // instead of appearing to succeed.
    if ((process.env.MULTI_TENANT ?? "").toLowerCase() !== "true") {
      return {
        ok: false,
        kind: "ModeDisabled",
        message:
          "This installation doesn't offer hosted signup. Get in touch and we'll set you up.",
      };
    }

    const slug = args.input.slug.toLowerCase();

    // The actor recorded against every audit row this produces. Not a
    // PlatformUser — nobody at the vendor authorised it — so it's a
    // synthetic id that reads unambiguously in the log, paired with
    // the signer's own email so the trail leads back to a person.
    const actor = {
      id: "self-serve-signup",
      email: args.input.adminEmail.trim().toLowerCase(),
    };

    const provisioned = await this.platform.provisionTenant({
      input: {
        slug,
        name: args.input.name.trim(),
        adminEmail: actor.email,
        adminName: args.input.adminName.trim(),
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
          message: `The name "${slug}" is already taken. Try another.`,
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
        tenantName: args.input.name.trim(),
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
          name: args.input.adminName.trim(),
          email: actor.email,
          cooperative: args.input.name.trim(),
          deploymentInterest: "HOSTED",
          source: "self-serve-signup",
          message: `Self-provisioned tenant "${slug}".`,
        },
      })
      .catch((err: unknown) => {
        // A lead row is bookkeeping. The tenant is already live and the
        // caller is holding credentials for it; failing here would be
        // reporting failure for something that worked.
        this.log.warn({ slug, err }, "[public] signup lead insert failed");
      });

    this.log.info({ slug, licensed }, "[public] self-serve tenant provisioned");

    return {
      ok: true,
      slug,
      name: args.input.name.trim(),
      adminEmail: actor.email,
      bootstrapPassword: provisioned.bootstrapPassword ?? null,
      licensed,
    };
  }
}
