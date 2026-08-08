import type { FastifyReply, FastifyRequest } from "fastify";

import {
  customerBaseSchema,
  customerListQuerySchema,
  customerSchema,
} from "./schemas";

/**
 * Presentation layer for the base customer CRUD surface.
 *
 * **Phase 2 pattern**: stateless singleton. Each method reads the
 * per-request `CustomerService` instance from `req.customerServices`
 * — that container is populated by the `buildCustomerServices`
 * preHandler in `index.ts` from the tenant-scoped Prisma client.
 *
 * The `!` assertion on `req.customerServices` is sound because route
 * registration always runs after the preHandler that sets it; if
 * that's ever wrong, you'll see `Cannot read property 'customer' of
 * undefined` at runtime, not a silent cross-tenant leak.
 */
export class CustomerController {
  list = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = customerListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    return req.customerServices!.customer.list(parsed.data);
  };

  show = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const c = await req.customerServices!.customer.findByIdOrNumber(
      req.params.id,
    );
    if (!c) return reply.code(404).send({ error: "NotFound" });
    return c;
  };

  create = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = customerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const created = await req.customerServices!.customer.create(parsed.data);
    return reply.code(201).send(created);
  };

  summary = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const result = await req.customerServices!.customer.summary(req.params.id);
    if (!result) return reply.code(404).send({ error: "NotFound" });
    return result;
  };

  repeatEligibility = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const result = await req.customerServices!.customer.repeatEligibility(
      req.params.id,
    );
    if (!result) return reply.code(404).send({ error: "NotFound" });
    return result;
  };

  remove = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const result = await req.customerServices!.customer.remove(
      req.params.id,
      req.user.sub,
    );
    if (!result.ok) {
      if (result.reason === "NotFound") {
        return reply.code(404).send({ error: "NotFound" });
      }
      // 409, not 403: the caller is allowed to delete customers, this
      // particular one just isn't deletable. The counts let the UI say
      // which history is in the way instead of a bare refusal.
      const { counts } = result;
      const parts = [
        counts.loans && `${counts.loans} loan(s)`,
        counts.contributions && `${counts.contributions} contribution(s)`,
        counts.savingsTransactions &&
          `${counts.savingsTransactions} savings transaction(s)`,
        counts.coMakerFor && `co-maker on ${counts.coMakerFor} loan(s)`,
        counts.fundTransactions &&
          `${counts.fundTransactions} fund transaction(s)`,
        counts.fundWithdrawals &&
          `${counts.fundWithdrawals} fund withdrawal(s)`,
      ].filter(Boolean);
      return reply.code(409).send({
        error: "HasHistory",
        message: `This customer has ${parts.join(", ")} and cannot be deleted. Financial records must be kept. To honour a privacy request, erase their personal data instead.`,
        counts,
      });
    }
    return reply.code(204).send();
  };

  update = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = customerBaseSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    const result = await req.customerServices!.customer.update(
      req.params.id,
      parsed.data,
    );
    if (!result.ok) {
      // Phone rules need the stored record to know what changed, so
      // they run in the service rather than the schema — the failure
      // shape still matches every other validated endpoint.
      if (result.reason === "NotFound")
        return reply.code(404).send({ error: "NotFound" });
      if (result.reason === "Erased")
        return reply.code(409).send({
          error: "Erased",
          message:
            "This customer's personal data was erased under a data privacy request; the record can no longer be edited.",
        });
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: result.issues });
    }
    return result.customer;
  };
}
