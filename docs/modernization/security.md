# Security

Living reference. Point-in-time findings: `security-audit.md`.

---

## Controls in place

| Control                  | Implementation                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------- |
| Password hashing         | **argon2id** — not bcrypt, not PBKDF2                                                 |
| Tokens                   | JWT access + refresh, rotated on use                                                  |
| Refresh re-use detection | presenting an already-revoked token revokes the whole family — the theft signal       |
| Session revocation       | `User.sessionsRevokedAt` cutoff enforced in `authenticate`                            |
| Account disable          | `User.active`, checked at login **and** refresh; deactivating also cuts live sessions |
| 2FA                      | TOTP with single-use recovery codes                                                   |
| Authorization            | permission keys resolved from DB role assignments; `requirePermission` per route      |
| Delegation               | time-bound via `expiresAt`, filtered at permission-resolution time                    |
| Rate limiting            | global, plus a tighter per-route limit on `/auth/login`                               |
| Headers                  | helmet                                                                                |
| CORS                     | origin pinned to `config.webOrigin`, credentials enabled                              |
| Audit                    | append-only; impersonation attributes both the tenant user and the platform operator  |
| Tenant isolation         | schema-per-tenant, with a dedicated test                                              |

Backend authorization is authoritative everywhere inspected. UI gates mirror the
endpoint's exact permission key and are never the only gate.

## Open items

**S-1 (P1) — uploads on local disk.** `config.uploadsDir`, served by a static
plugin on the same process. KYC identity documents — government IDs, payslips,
selfies — live on the API container's filesystem.

**Correction (11 Aug 2026):** the Phase 0 audit claimed this included "no
signed-URL expiry". That was wrong, and it was wrong because I asserted it
without reading `uploads/signing.ts`. Signed access **does** exist: a protected
path needs `?exp=<unix-ms>&sig=<hmac>`, minted through an authenticated
endpoint, and `static.plugin.ts` enforces it on every request — 401 on expiry,
403 on a bad signature. The module's own header is candid about what that does
and does not buy: it closes the anonymous hole, but any authenticated caller can
sign any path, so it is not an ownership model.

What remains true, and is the real gap:

|                                |                                                                       |
| ------------------------------ | --------------------------------------------------------------------- |
| Access control                 | ✅ HMAC + expiry, enforced                                            |
| Durability                     | ❌ one container filesystem                                           |
| Backup                         | ⚠️ now covered by `UPLOADS_DIR` in `backup.sh`, but only if it is set |
| Horizontal scaling             | ❌ a second API process cannot read the first's files                 |
| Lifecycle / retention on blobs | ❌                                                                    |

Object storage remains the structural answer (roadmap 3.1), but it is no longer
urgent for _access_, only for durability and scale.

**S-2 (P2) — CSP disabled.** `helmet` is registered with
`contentSecurityPolicy: false`. Understandable in development; in production it
removes the main defence against injected script in an admin UI that renders
customer-supplied strings. Roadmap 3.3.

**S-3 (P2) — secrets management undocumented.** Configuration flows through
`.env`. Adequate for self-hosted single-tenant, thin for the multi-tenant
platform story.

**S-4 (P3) — no automated dependency scanning** observed in CI.

## Audit trail — §56

Recorded today: `action`, `actorId`, `targetType`, `targetId`, `payload`,
`createdAt`, and the impersonating platform operator where applicable.
Append-only; no update path exists.

**Not yet recorded:** `request_id`, `ip_address`, `user_agent`. §56 lists all
three. Fastify already generates a request id, so adding them is mechanical and
would make the trail materially more useful during an incident.

## The rule for new work

Never trust a frontend check, and never let a service-layer check be the only
one. The borrower portal calls repositories **directly**, bypassing the workflow
services — which is why the erased-customer and archived-customer guards are
implemented at _both_ layers. A guard that exists only in a service protects
only the doors that service owns.
