# API Audit

**319 route registrations** — 139 GET, 143 POST, 14 PATCH, 12 DELETE, 11 PUT —
across **42** `*.routes.ts` files in **41** feature folders.

## Shape

Action-oriented rather than pure REST (`/loans/:id/disburse`,
`/users/:id/force-logout`, `/customers/:id/archive`). For a workflow system this
is correct: a state transition is not a field update, and naming it makes both
the permission gate and the audit row honest about what happened.

Mounted under `/api/v1`, with `/platform`, `/public` and `/public/co-maker` as
separate prefixes. **The versioning the brief asks for in §73 already exists.**

## Validation — pass

zod at the boundary in every controller inspected, with a consistent failure
shape (`{ error: "ValidationError", issues }`). Backend validation is
authoritative; the frontend shares schemas via `libs/shared-types`, so the two
cannot drift silently. §42 satisfied.

## Authorization — pass

`app.requirePermission("key")` as a preHandler on essentially every route.
Permissions resolve from role _assignments_ in the database, not the legacy
`User.role` enum. A boot-time reconcile in `apps/api/src/main.ts` seeds the
permission catalog and default roles, so a newly added permission key self-heals
on deploy rather than requiring a manual sync.

## Error mapping — good

Services return discriminated unions; controllers map them to status codes with
a consistent convention:

- `400` — malformed payload (zod)
- `404` — target does not exist
- `409` — well-formed request refused on **state** (`AmlBlocked`, `HasLiveLoan`,
  `CustomerErased`, `CustomerArchived`, `HasOpenLoans`, `LastAdmin`, `Self`)

The 409 family is used consistently and the messages name the obstruction rather
than merely refusing, which is what makes them actionable in the UI.

## Gaps

**API-1 (P2) — OpenAPI is thinner than the real contract.** `@fastify/swagger` +
`swagger-ui` are registered and served at `/docs`, but most routes do not declare
a `schema` in their route options, so the generated spec lacks request/response
shapes. §67 asks for request, response, auth, errors and idempotency documented
per endpoint. Attaching zod-derived schemas is mechanical and also buys runtime
response validation.

**API-2 (P0) — no idempotency on money endpoints.** See
`financial-engine-audit.md` P0-2. This is an API-surface concern as much as a
data one: the contract needs an `Idempotency-Key` header, and a repeat must
return the original result rather than an error.

## Scorecard

| Brief requirement                         | Status           |
| ----------------------------------------- | ---------------- |
| §41 thin controllers, logic in services   | EXISTS — GOOD    |
| §42 DTO validation, backend authoritative | EXISTS — GOOD    |
| §73 API versioning (`/api/v1`)            | EXISTS — GOOD    |
| §67 complete OpenAPI documentation        | PARTIAL          |
| §13 idempotency on financial endpoints    | **MISSING (P0)** |
