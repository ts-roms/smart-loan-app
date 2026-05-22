import type { PrismaClient } from "@loan/db";
import type { FastifyBaseLogger } from "fastify";

import type { CaptureLeadInput } from "./schemas";

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

export class PublicService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly log: FastifyBaseLogger,
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
}
