# Architecture — SmartLoan API

The canonical contract for adding or restructuring API features. The
customers, kyc, and dorsi features are the live reference implementation;
this doc is the why + when behind that shape.

## Layering

Four concerns, mapped to four physical locations:

| Concern            | Lives in                                                          | Knows about                                                                              |
| ------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Presentation**   | `apps/api/src/features/<feature>/*.routes.ts` + `*.controller.ts` | Fastify, zod, the service layer                                                          |
| **Application**    | `apps/api/src/features/<feature>/*.service.ts`                    | Repositories, cross-cutting services (audit / notifications / screening), other services |
| **Domain**         | `libs/shared-types/`, Prisma-generated types                      | Nothing (pure types)                                                                     |
| **Infrastructure** | `libs/db/src/repositories/`, `apps/api/src/providers.ts`          | Prisma, external providers (AML, payments, LLM, mail)                                    |

Reading directions flow inward only:

```
routes ──▶ controller ──▶ service ──▶ repository ──▶ Prisma
                              │
                              └─▶ other services (audit, notifications, screening)
```

Routes never call repos. Services never know about Fastify. Repositories
never know about HTTP. This isolation is the whole point — each layer
can be swapped without touching the others.

## Per-feature file layout

```
apps/api/src/features/<feature>/
├── <feature>.routes.ts          # REQUIRED — HTTP route declarations
├── <feature>.controller.ts      # OPTIONAL — request adapter
├── <feature>.service.ts         # OPTIONAL — business orchestration
├── schemas.ts                   # OPTIONAL — zod inputs + inferred types
├── helpers.ts                   # OPTIONAL — pure utilities
├── types.ts                     # OPTIONAL — domain types zod can't infer
└── index.ts                     # REQUIRED — plugin entry, composition root
```

Multiple sub-surfaces in one feature get their own triad. Customers, for
example, has:

```
features/customers/
├── customers.{routes,controller,service}.ts   # base CRUD
├── bulk-import.{routes,controller,service}.ts # /bulk endpoint
├── ledger.{routes,controller,service}.ts      # ledger + PDF + email
├── schemas.ts
├── helpers.ts
└── index.ts                                   # wires all three triads
```

Each `*.routes.ts` exports a `register<Name>Http(app, controller)` function;
`index.ts` instantiates the wiring and calls each register function in turn.

## Layer responsibilities in detail

### `routes.ts`

Fastify wiring only. URL paths, HTTP methods, permission `preHandler`s,
Fastify route generics (`Params`, `Querystring`). One line per endpoint.

```typescript
export function registerCustomerHttp(
  app: FastifyInstance,
  controller: CustomerController,
): void {
  app.get("/", controller.list);
  app.get<{ Params: { id: string } }>("/:id", controller.show);
  app.post("/", controller.create);
  app.patch<{ Params: { id: string } }>("/:id", controller.update);
  app.get<{ Params: { id: string } }>("/:id/summary", controller.summary);
  app.get<{ Params: { id: string } }>(
    "/:id/repeat-eligibility",
    controller.repeatEligibility,
  );
}
```

Permission gates that apply per-route go here, not inside the controller:

```typescript
app.post(
  "/bulk",
  { preHandler: app.requirePermission("customers.write") },
  controller.run,
);
```

### `controller.ts`

A class whose methods are HTTP handlers. Each method:

1. zod-parses the body / query (rejects with 400 on failure)
2. Calls the service with the parsed input
3. Maps the service result to an HTTP response (null → 404, custom errors → specific codes, otherwise return value or `reply.code(201).send(...)`)

```typescript
export class CustomerController {
  constructor(private readonly service: CustomerService) {}

  create = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = customerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const created = await this.service.create(parsed.data);
    return reply.code(201).send(created);
  };
}
```

Use class **arrow-method fields** (not regular methods) so `this` stays
bound when the route file passes the method around as a callback. This is
the convention the customers canary uses.

### `service.ts`

The business layer. Plain classes; constructor params are the deps. The
service is the only place that orchestrates: combines multiple repos,
fires audit logs, dispatches notifications, runs decisioning, kicks off
AML screens.

```typescript
export class CustomerService {
  constructor(
    private readonly customers: CustomerRepository,
    private readonly prisma: PrismaClient,
    private readonly screening: ScreeningRepository,
  ) {}

  async create(input: CustomerWriteInput): Promise<Customer> {
    const created = await this.customers.create({
      ...input,
      dateOfBirth: new Date(input.dateOfBirth),
      hireDate: toDateOrUndefined(input.hireDate),
    });
    // Fire-and-forget AML screen. Never blocks the response.
    void this.screening.screen(created.id).catch(() => undefined);
    return created;
  }
}
```

Services never touch Fastify. No `req`, no `reply`, no decorators. They
take inputs, return outputs (or `null` for not-found), and throw for
exceptional cases. The controller maps the throw to an HTTP code.

### `schemas.ts`

All zod schemas for the feature, plus the inferred TypeScript types.
Extract the moment you have ≥ 2 schemas or one ≥ 30 lines.

```typescript
import { z } from "zod";

export const applySchema = z.object({
  customerId: z.string().uuid(),
  productCode: z.string().min(1).max(40),
  principal: z.number().positive(),
  // ...
});

export type ApplyInput = z.infer<typeof applySchema>;
```

If a schema needs cross-field validation (`.superRefine`), keep the
_base_ schema separately so a future PATCH can use `.partial()`:

```typescript
export const customerBaseSchema = z.object({
  /* fields */
});
export const customerSchema = customerBaseSchema.superRefine(/* refinement */);
```

### `helpers.ts`

Pure utility functions used by 2+ files in the feature. CSV formatters,
date coercion, scope normalisation, etc. No I/O, no Fastify.

```typescript
export function toDateOrUndefined(s: string | undefined): Date | undefined {
  return s ? new Date(s) : undefined;
}

export function normalizeScope(raw: string | undefined): LedgerScope {
  const u = (raw ?? "ALL").toUpperCase();
  return u === "LOANS" || u === "COOP" || u === "ALL"
    ? (u as LedgerScope)
    : "ALL";
}
```

### `types.ts`

Domain types that aren't derived from zod. Service intermediate values,
internal unions, view-model shapes. Most features don't need this.

### `index.ts`

The composition root for the feature. Instantiates repos, wires services
into controllers, registers routes against the Fastify app:

```typescript
import { CustomerLedgerRepository, CustomerRepository } from "@loan/db";
import type { FastifyInstance } from "fastify";

import { BulkImportController } from "./bulk-import.controller.js";
import { BulkImportService } from "./bulk-import.service.js";
import { registerBulkImportHttp } from "./bulk-import.routes.js";
import { CustomerController } from "./customers.controller.js";
import { registerCustomerHttp } from "./customers.routes.js";
import { CustomerService } from "./customers.service.js";
// ...

export async function customerRoutes(app: FastifyInstance): Promise<void> {
  // Infrastructure
  const customerRepo = new CustomerRepository(app.prisma);
  const ledgerRepo = new CustomerLedgerRepository(app.prisma);

  // Application services
  const customerService = new CustomerService(
    customerRepo,
    app.prisma,
    app.screening,
  );
  const bulkImportService = new BulkImportService(customerRepo, app.screening);
  const ledgerService = new CustomerLedgerService(
    customerRepo,
    ledgerRepo,
    app.notifications,
    app.prisma,
  );

  // Presentation
  const customerController = new CustomerController(customerService);
  const bulkImportController = new BulkImportController(bulkImportService);
  const ledgerController = new CustomerLedgerController(ledgerService);

  // Feature-wide cross-cutting hook
  app.addHook("preHandler", app.authenticate);

  // Routes
  registerCustomerHttp(app, customerController);
  registerBulkImportHttp(app, bulkImportController);
  registerLedgerHttp(app, ledgerController);
}
```

That `customerRoutes` function is what the central registrar in
`apps/api/src/routes/index.ts` imports and mounts.

## When each layer is optional

```
routes.ts  →  always
index.ts   →  always
schemas.ts →  ≥ 2 zod schemas, OR one schema > 30 lines
controller →  ≥ 1 handler does meaningful request shaping
              (rejecting on validation, mapping a custom error,
              shaping the response — not just plumbing)
service    →  ≥ 1 path orchestrates beyond a single repo call
              (combines repos, calls audit/notifications/screening,
              has side effects, runs business validation)
helpers    →  ≥ 2 files in the feature share a pure util
types.ts   →  zod inference can't express the shape you need
```

A pure CRUD wrapper around one repo with no orchestration legitimately
doesn't need a controller or service. Don't add layers for symmetry —
add them when they earn their keep. Today, of the 28 features:

- 12 features benefit from full layering (customers, kyc, dorsi, loans,
  loan-products, payments, accounting, cooperative, repossession, lease,
  demand-letters, reports, auth, portal, rbac, delegations — give or
  take).
- 10 need only schemas extracted.
- 6 can stay as single-file routes (health, scoring, uploads,
  notifications-factory, screening-factory, jobs-factory).

## Dependency injection via plugin closures

Fastify plugins are closures. The `await app.register(plugin, { prefix })`
call is the composition root for a feature — instantiate everything
inside, wire it together, register the routes. No DI container needed:

- **Repos** are constructed with `app.prisma` (decorated by `fastifyPrisma`).
- **Cross-cutting services** like `app.notifications`, `app.screening`,
  `app.requirePermission`, `app.authenticate` are decorated once by the
  central registrar (`apps/api/src/routes/index.ts`) and available
  throughout.
- **Feature services** are constructed once per plugin registration. Each
  feature gets a fresh set of objects; nothing leaks across feature
  boundaries.

This pattern beats a decorator-based DI framework because:

- Zero runtime cost. Classes are just classes.
- Every dependency is visible at the call site (the `new Service(...)` line).
- Tests construct services directly with mocked deps. No `@Inject` plumbing.
- The plugin function is the single composition root — no global registry to reason about.

## Cross-feature concerns

```
apps/api/src/
├── lib/            # pure helpers used by ≥ 2 features
│   ├── branding.ts
│   ├── anomaly.ts
│   └── llm.ts
└── plugins/        # cross-cutting Fastify decorators (auth, permissions, …)
```

The decision rule:

```
       one feature   →  apps/api/src/features/<feature>/helpers.ts
two or more features  →  apps/api/src/lib/
also needed by web    →  promote to libs/shared-utils or libs/shared-types
```

When promoting from `apps/api/src/lib/` to a workspace library, the
imports inside `apps/api` should switch from `../lib/branding.js` to
`@loan/<lib-name>` so the API and web app see the same module path.

## Naming conventions

- File names: `<feature>.<layer>.ts` for the layered files; `schemas.ts`,
  `helpers.ts`, `types.ts`, `index.ts` are unprefixed because they're
  unambiguous inside a feature folder.
- Exported function names: feature plugin is `<feature>Routes`,
  HTTP registration is `register<Sub>Http`, service class is
  `<Sub>Service`, controller class is `<Sub>Controller`.
- Where `<feature>` is a noun (loans, customers), prefer the noun form.
  Where it's an action that doesn't read well as a noun, lean on the
  domain term (`screening`, not `screenings`).

## How to add a new feature

1. Create `apps/api/src/features/<name>/` and decide which layers you
   need (always `routes` + `index`; usually `schemas`; sometimes
   `controller` + `service`).
2. Wire DI in `index.ts` exporting `<name>Routes(app)`.
3. Import in `apps/api/src/routes/index.ts` and add an `app.register`
   line with the URL prefix.
4. Add permissions to `libs/auth/src/permissions.ts` if introducing new
   gates. Update the seed roles if any of those should default-on.
5. Add Prisma models + migration if storage is new. Generated client +
   types flow out via `@loan/db` re-exports.

## How to test

Pure logic (services without DB) → vitest in the feature folder or in
the lib it depends on. See `libs/kyc/src/validate.test.ts`,
`libs/accounting/src/posting.test.ts`, `libs/db/src/lib/dorsi-helpers.test.ts`
for the live examples.

HTTP integration (handler → service → repo → DB) → deferred until a
Playwright suite is set up. The smoke-test checklist at
`docs/smoke-tests/customer-flows.md` is the manual stand-in.

## Migration pointers

- A feature currently in lift-and-shift form (`<feature>.routes.ts`
  only) migrates by reading the route file, identifying schemas →
  `schemas.ts`, extracting business logic → `service.ts`, slimming the
  route to handler-dispatch → `controller.ts`, and wiring up `index.ts`.
- Run `pnpm --filter @loan/api build` after each feature; tsc catches
  90 % of integration issues.
- Don't reshape the URL contract during a structural migration. Routes
  - verbs + status codes stay byte-identical; only the file layout
    changes. That keeps the diff reviewable and the smoke-test checklist
    valid.
