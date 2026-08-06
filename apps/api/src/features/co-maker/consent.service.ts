/**
 * Co-maker consent — invite tokens and the answers they collect.
 *
 * A co-maker is jointly liable for the loan, so agreeing to it is
 * their decision rather than a box the officer ticks. They have no
 * account here and realistically never will, so the officer sends a
 * link and the link is the authorization.
 *
 * ## Token shape
 *
 * `<tenantSlug>.<32 random bytes, hex>`.
 *
 * The slug rides along because these endpoints are anonymous: tenant
 * resolution normally reads a JWT claim, and there's no JWT. Without
 * it a multi-tenant deploy couldn't tell which schema the token
 * belongs to. It isn't a secret — the random half is what makes the
 * token unguessable.
 *
 * Stored rather than HMAC-derived, unlike the upload signatures.
 * Re-inviting has to invalidate the previous link, and a stateless
 * signature can't be revoked.
 */

import { randomBytes } from "node:crypto";

import type { CoMakerRepository } from "@loan/db";

/**
 * How long an invite stays good. Generous on purpose: a co-maker is
 * often a parent or an employer who isn't waiting by their phone, and
 * an expired link means the officer has to notice and resend.
 */
export const INVITE_TTL_DAYS = 30;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function mintInviteToken(tenantSlug: string): string {
  return `${tenantSlug}.${randomBytes(32).toString("hex")}`;
}

/**
 * Split a token into its tenant and secret halves.
 *
 * Returns null on anything malformed, so a caller can 404 without
 * distinguishing "wrong shape" from "no such token" — telling those
 * apart only helps someone probing.
 */
export function parseInviteToken(
  token: string,
): { tenantSlug: string; token: string } | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const tenantSlug = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!SLUG_RE.test(tenantSlug)) return null;
  if (!/^[0-9a-f]{64}$/.test(secret)) return null;
  return { tenantSlug, token };
}

type Invite = NonNullable<
  Awaited<ReturnType<CoMakerRepository["findByInviteToken"]>>
>;

export type ConsentLookup =
  | { ok: true; invite: Invite }
  /**
   * The token resolved to a real co-maker but the link has run out.
   *
   * The row comes back anyway, which is the point: someone clicking a
   * day late is still evidence the link reached them, and that is
   * exactly what an officer chasing a silent co-maker needs to know.
   * Without it, "expired" and "never delivered" look identical from
   * the outside — the same two situations `linkOpenedAt` exists to
   * separate.
   */
  | { ok: false; reason: "Expired"; invite: Invite }
  | { ok: false; reason: "NotFound" };

export class CoMakerConsentService {
  constructor(private readonly coMakers: CoMakerRepository) {}

  /**
   * Resolve a token, separating expiry from absence so the page can
   * say "this link has expired, ask for a new one" rather than a bare
   * 404 that reads as a typo.
   */
  async lookup(token: string, now: Date = new Date()): Promise<ConsentLookup> {
    const invite = await this.coMakers.findByInviteToken(token);
    if (!invite) return { ok: false, reason: "NotFound" };
    if (invite.inviteExpiresAt && invite.inviteExpiresAt <= now) {
      // Carries the row. A late click is still a delivery, and the
      // caller stamps `linkOpenedAt` from it — see the GET route.
      return { ok: false, reason: "Expired", invite };
    }
    return { ok: true, invite };
  }

  /**
   * Record an answer.
   *
   * Answering is one-shot: a co-maker who approved can't quietly
   * flip to declined afterwards, and one who declined can't be talked
   * into re-clicking. Either way the officer resends, which mints a
   * fresh token and clears the old answer — so a change of mind
   * leaves a trail instead of overwriting one.
   */
  async respond(
    token: string,
    decision: "APPROVED" | "DECLINED",
    declineReason?: string,
  ): Promise<
    | { ok: true }
    | { ok: false; reason: "NotFound" | "Expired" | "AlreadyAnswered" }
  > {
    const found = await this.lookup(token);
    if (!found.ok) return found;
    if (found.invite.status !== "PENDING") {
      return { ok: false, reason: "AlreadyAnswered" };
    }
    await this.coMakers.respond(found.invite.id, decision, declineReason);
    return { ok: true };
  }
}
