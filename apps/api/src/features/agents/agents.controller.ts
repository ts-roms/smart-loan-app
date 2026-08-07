import {
  AgentNotFoundError,
  AgentPayoutNotFoundError,
  NoAgentProfileError,
  PayoutAlreadyVoidedError,
  UserAlreadyAgentError,
} from "@loan/db";
import {
  InvalidCommissionRateError,
  NothingPayableError,
  PayoutMismatchError,
} from "@loan/loans";
import type { FastifyReply, FastifyRequest } from "fastify";

import {
  agentBookQuerySchema,
  agentListQuerySchema,
  createAgentSchema,
  createPayoutSchema,
  payoutListQuerySchema,
  updateAgentSchema,
  voidPayoutSchema,
} from "./schemas";

/**
 * HTTP adapter for the agent directory and the agents' own books.
 *
 * Stateless singleton; the per-request repository hangs off
 * `req.agentServices` (Phase 2 pattern — see docs/architecture.md).
 */
export class AgentsController {
  list = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = agentListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    return req.agentServices!.agents.list(parsed.data);
  };

  get = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    try {
      return await req.agentServices!.agents.get(req.params.id);
    } catch (e) {
      if (e instanceof AgentNotFoundError) {
        return reply.code(404).send({ error: "NotFound", message: e.message });
      }
      throw e;
    }
  };

  create = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = createAgentSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    try {
      const agent = await req.agentServices!.agents.create({
        ...parsed.data,
        createdById: req.user.sub,
      });
      return reply.code(201).send(agent);
    } catch (e) {
      // 409, not 400: the request is well-formed and the caller can see
      // for themselves that the user is already an agent.
      if (e instanceof UserAlreadyAgentError) {
        return reply.code(409).send({ error: "Conflict", message: e.message });
      }
      if (e instanceof InvalidCommissionRateError) {
        return reply
          .code(400)
          .send({ error: "ValidationError", message: e.message });
      }
      throw e;
    }
  };

  update = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = updateAgentSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    try {
      return await req.agentServices!.agents.update(req.params.id, parsed.data);
    } catch (e) {
      if (e instanceof AgentNotFoundError) {
        return reply.code(404).send({ error: "NotFound", message: e.message });
      }
      if (e instanceof InvalidCommissionRateError) {
        return reply
          .code(400)
          .send({ error: "ValidationError", message: e.message });
      }
      throw e;
    }
  };

  /** Any agent's book. Requires `agents.read` — this is the staff view. */
  book = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = agentBookQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    try {
      const agent = await req.agentServices!.agents.get(req.params.id);
      const book = await req.agentServices!.agents.book(agent.id, parsed.data);
      return { agent, ...book };
    } catch (e) {
      if (e instanceof AgentNotFoundError) {
        return reply.code(404).send({ error: "NotFound", message: e.message });
      }
      throw e;
    }
  };

  /**
   * The signed-in agent's OWN book.
   *
   * The agent id comes from the token's subject, never from the request.
   * `agents.self` says "you may see your own book"; it is this lookup
   * that decides whose, so there is no id an agent could supply to read
   * someone else's.
   */
  myBook = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = agentBookQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    try {
      const agentId = await req.agentServices!.agents.requireOwnAgentId(
        req.user.sub,
      );
      const agent = await req.agentServices!.agents.get(agentId);
      const book = await req.agentServices!.agents.book(agentId, parsed.data);
      return { agent, ...book };
    } catch (e) {
      // 403 rather than 404: the caller authenticated fine, they simply
      // are not an agent, and the message says what to do about it.
      if (e instanceof NoAgentProfileError) {
        return reply.code(403).send({ error: "Forbidden", message: e.message });
      }
      throw e;
    }
  };

  // ─── Payouts ────────────────────────────────────────────────────

  /** What the coop owes this agent right now, and the loans behind it. */
  payable = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    try {
      const agent = await req.agentServices!.agents.get(req.params.id);
      return {
        agent,
        ...(await req.agentServices!.agents.payable(agent.id)),
      };
    } catch (e) {
      if (e instanceof AgentNotFoundError) {
        return reply.code(404).send({ error: "NotFound", message: e.message });
      }
      throw e;
    }
  };

  /** The signed-in agent's own view of what they are owed. */
  myPayable = async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const agentId = await req.agentServices!.agents.requireOwnAgentId(
        req.user.sub,
      );
      return {
        ...(await req.agentServices!.agents.payable(agentId)),
        payouts: await req.agentServices!.agents.listPayouts({ agentId }),
      };
    } catch (e) {
      if (e instanceof NoAgentProfileError) {
        return reply.code(403).send({ error: "Forbidden", message: e.message });
      }
      throw e;
    }
  };

  listPayouts = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = payoutListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    return req.agentServices!.agents.listPayouts(parsed.data);
  };

  createPayout = async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = createPayoutSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    try {
      const payout = await req.agentServices!.agents.createPayout({
        ...parsed.data,
        createdById: req.user.sub,
      });
      return reply.code(201).send(payout);
    } catch (e) {
      /*
       * 409 for both, and the message goes straight through.
       *
       * These are the two ways a payout run goes wrong in practice —
       * someone else paid one of the loans while this sheet was open,
       * or the amount and the lines disagree. Both are recoverable by
       * the person at the screen, and both messages name exactly which
       * loan or which figure. Flattening them into "Bad Request" would
       * throw away the only part that helps.
       */
      if (
        e instanceof NothingPayableError ||
        e instanceof PayoutMismatchError
      ) {
        return reply.code(409).send({ error: e.code, message: e.message });
      }
      if (e instanceof AgentNotFoundError) {
        return reply.code(404).send({ error: "NotFound", message: e.message });
      }
      throw e;
    }
  };

  voidPayout = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = voidPayoutSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "ValidationError", issues: parsed.error.issues });
    }
    try {
      return await req.agentServices!.agents.voidPayout(req.params.id, {
        reason: parsed.data.reason,
        voidedById: req.user.sub,
      });
    } catch (e) {
      if (e instanceof AgentPayoutNotFoundError) {
        return reply.code(404).send({ error: "NotFound", message: e.message });
      }
      if (e instanceof PayoutAlreadyVoidedError) {
        return reply.code(409).send({ error: e.code, message: e.message });
      }
      throw e;
    }
  };
}
