import type {
  Agent,
  AgentBook,
  AgentPayable,
  AgentPayout,
  LoanApplication,
} from "@loan/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getApiClient } from "../client";
import { toQueryString } from "../query-string";

/**
 * Field agents — the directory, and the book each has written.
 *
 * Two audiences, and the split matters. `useAgents` / `useAgentBook` are
 * the STAFF view and need `agents.read`; `useMyAgentBook` is what an
 * agent sees of themselves and needs only `agents.self`. The second does
 * not take an id — the server resolves it from the token — so there is
 * no argument an agent could pass to read a colleague's earnings.
 */

export const agentKeys = {
  all: ["agents"] as const,
  list: (filter?: AgentFilter) =>
    [...agentKeys.all, "list", filter ?? {}] as const,
  detail: (id: string) => [...agentKeys.all, "detail", id] as const,
  book: (id: string, filter?: AgentBookFilter) =>
    [...agentKeys.all, "book", id, filter ?? {}] as const,
  myBook: (filter?: AgentBookFilter) =>
    [...agentKeys.all, "me", filter ?? {}] as const,
  payable: (id: string) => [...agentKeys.all, "payable", id] as const,
  myPayable: ["agents", "me", "payable"] as const,
  payouts: (agentId?: string) =>
    [...agentKeys.all, "payouts", agentId ?? "all"] as const,
};

export interface AgentFilter {
  active?: boolean;
  /** Matches the agent number, name, email or territory. */
  q?: string;
  take?: number;
  skip?: number;
}

export interface AgentBookFilter {
  status?: string;
  take?: number;
  skip?: number;
}

// ─── staff: the directory ─────────────────────────────────────────

export function useAgents(filter?: AgentFilter) {
  return useQuery({
    queryKey: agentKeys.list(filter),
    queryFn: () =>
      getApiClient().get<Agent[]>(`/agents${toQueryString(filter)}`),
  });
}

export function useAgent(idOrNumber: string | null) {
  return useQuery({
    queryKey: agentKeys.detail(idOrNumber ?? ""),
    queryFn: () => getApiClient().get<Agent>(`/agents/${idOrNumber}`),
    enabled: Boolean(idOrNumber),
  });
}

export function useAgentBook(
  idOrNumber: string | null,
  filter?: AgentBookFilter,
) {
  return useQuery({
    queryKey: agentKeys.book(idOrNumber ?? "", filter),
    queryFn: () =>
      getApiClient().get<AgentBook>(
        `/agents/${idOrNumber}/book${toQueryString(filter)}`,
      ),
    enabled: Boolean(idOrNumber),
  });
}

export interface CreateAgentInput {
  userId: string;
  /**
   * A FRACTION of principal — 0.02 is 2%. `null` inherits the product's
   * rate; 0 means this agent earns nothing, which is not the same thing.
   */
  commissionRate?: number | null;
  territory?: string | null;
  notes?: string | null;
}

export function useCreateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAgentInput) =>
      getApiClient().post<Agent>("/agents", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: agentKeys.all }),
  });
}

export interface UpdateAgentInput {
  commissionRate?: number | null;
  territory?: string | null;
  notes?: string | null;
  active?: boolean;
}

export function useUpdateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateAgentInput & { id: string }) =>
      getApiClient().request<Agent>(`/agents/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: agentKeys.all }),
  });
}

// ─── the agent's own book ─────────────────────────────────────────

/**
 * No id parameter, deliberately. The server resolves the agent from the
 * signed-in user, so this hook cannot be pointed at anyone else.
 */
export function useMyAgentBook(filter?: AgentBookFilter) {
  return useQuery({
    queryKey: agentKeys.myBook(filter),
    queryFn: () =>
      getApiClient().get<AgentBook>(`/agents/me${toQueryString(filter)}`),
  });
}

// ─── assignment ───────────────────────────────────────────────────

/**
 * Credit a loan to an agent, move it, or clear it with `agentId: null`.
 *
 * Invalidates the loan as well as every agent view: the assignment
 * changes the loan's own detail page and moves commission between two
 * agents' books at once, so nothing that showed the old attribution can
 * be left standing.
 */
export function useAssignLoanAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      loanIdOrNumber,
      agentId,
    }: {
      loanIdOrNumber: string;
      agentId: string | null;
    }) =>
      getApiClient().request<LoanApplication>(
        `/loans/${loanIdOrNumber}/agent`,
        {
          method: "PUT",
          body: JSON.stringify({ agentId }),
        },
      ),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: agentKeys.all });
      void qc.invalidateQueries({ queryKey: ["loans"] });
      void qc.invalidateQueries({
        queryKey: ["loans", "detail", vars.loanIdOrNumber],
      });
    },
  });
}

// ─── payouts ──────────────────────────────────────────────────────

/**
 * What an agent is owed right now — the loans backing their slice of
 * account 2500 Agent Commission Payable.
 *
 * Not the same as `totals.earned` on their book, which is what they
 * have made over their whole career, paid and unpaid together.
 */
export function useAgentPayable(agentId: string | null) {
  return useQuery({
    queryKey: agentKeys.payable(agentId ?? ""),
    queryFn: () =>
      getApiClient().get<AgentPayable>(`/agents/${agentId}/payable`),
    enabled: Boolean(agentId),
  });
}

/** The signed-in agent's own view. Takes no id — the server knows. */
export function useMyPayable() {
  return useQuery({
    queryKey: agentKeys.myPayable,
    queryFn: () => getApiClient().get<AgentPayable>("/agents/me/payable"),
  });
}

export function useAgentPayouts(agentId?: string) {
  return useQuery({
    queryKey: agentKeys.payouts(agentId),
    queryFn: () =>
      getApiClient().get<AgentPayout[]>(
        `/agents/payouts${toQueryString(agentId ? { agentId } : undefined)}`,
      ),
  });
}

export interface CreatePayoutInput {
  agentId: string;
  /** The commissions this payment settles. */
  loanIds: string[];
  /** Must equal the sum of those commissions; the server checks. */
  amount: number;
  paidOn: string;
  method?: string | null;
  reference?: string | null;
  notes?: string | null;
}

export function useCreateAgentPayout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePayoutInput) =>
      getApiClient().post<AgentPayout>("/agents/payouts", input),
    // Everything: the payout moves loans out of payable, changes the
    // agent's outstanding figure, and adds a row to the history.
    onSuccess: () => qc.invalidateQueries({ queryKey: agentKeys.all }),
  });
}

export function useVoidAgentPayout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      getApiClient().post<AgentPayout>(`/agents/payouts/${id}/void`, {
        reason,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: agentKeys.all }),
  });
}
