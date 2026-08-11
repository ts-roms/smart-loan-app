# Security Audit

## Present and correct

| Control                | Evidence                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------- |
| Password hashing       | **argon2id** (`libs/auth/src/password.ts`) — not bcrypt, not PBKDF2                |
| JWT + refresh rotation | `libs/auth`; re-use of a revoked token revokes the whole family (theft signal)     |
| Session revocation     | `User.sessionsRevokedAt` cutoff enforced in `app.authenticate`                     |
| Account disable        | `User.active`, checked at login **and** refresh                                    |
| 2FA                    | TOTP with single-use recovery codes                                                |
| RBAC                   | permission-based, resolved from DB role assignments, `requirePermission` per route |
| Delegation             | `features/delegations`, time-bound via `expiresAt`, filtered at resolve time       |
| Helmet                 | registered (but see S-1)                                                           |
| CORS                   | origin pinned to `config.webOrigin`, credentials enabled                           |
| Rate limiting          | global, plus a tighter per-route limit on `/auth/login`                            |
| Audit trail            | append-only `AuditLogRepository`; impersonation recorded as a separate identity    |
| Tenant isolation       | schema-per-tenant plus a dedicated isolation test                                  |

This is a strong baseline — materially better than typical for a system of this
size. The controls that are usually missing (argon2id over bcrypt, refresh-token
re-use detection, permission-not-role authorization, impersonation attribution)
are all present.

## Gaps

**S-1 (P1) — uploads are served from local disk.** `apps/api/src/app.ts` creates
`config.uploadsDir` and registers a static plugin over it. KYC documents —
government IDs, payslips, selfies — therefore live on the API container's
filesystem and are served by the same process. Consequences: no durability
guarantee, no lifecycle/retention enforcement on the blobs, no signed-URL
expiry, and horizontal scaling breaks document access outright. This is
simultaneously the biggest security _and_ operational gap. See
`modernization-gap-analysis.md` GAP-07.

**S-2 (P2) — CSP disabled.** `helmet` is registered with
`contentSecurityPolicy: false`. Understandable in development, but it removes the
main defence against injected script in an admin UI that renders
customer-supplied strings. Enable a real policy for production builds.

**S-3 (P2) — secrets management undocumented.** Configuration flows through
`.env`. Adequate for self-hosted single-tenant; thin for the multi-tenant
platform story. Document the expected production mechanism.

**S-4 (P3) — no automated dependency/vulnerability scanning** observed in CI.

## Verified as _not_ a problem

- Frontend permission gates mirror the exact `requirePermission` key of the
  endpoint each control calls, and — more importantly — the UI gate is never the
  only gate. Server-side authorization is authoritative everywhere inspected.
- Erased and archived customers are refused at the **service and repository**
  layers, not merely hidden in the UI, so the borrower-portal path (which calls
  the repository directly) is covered too.
