/**
 * Loan approval chain hooks.
 *
 *   useLoanApprovals(loanId)       — list approval rows
 *   useApproveStep(loanId)         — mutate to approve current step
 *   useRejectStep(loanId)          — mutate to reject (notes mandatory)
 *   useApprovalChain(productCode)  — read chain definition
 *   useUpdateApprovalChain(code)   — admin: replace chain
 *
 * All loan-side endpoints accept either the loan UUID or the human "LN-..."
 * reference — pass whichever the caller has.
 */

import type {
  LoanApproval,
  LoanApprovalActionResult,
  LoanApprovalStep,
  LoanApprovalStepInput,
} from "@loan/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getApiClient } from "../client";

export const loanApprovalKeys = {
  forLoan: (loanIdOrNumber: string) =>
    ["loan-approvals", loanIdOrNumber] as const,
  chain: (productCode: string) => ["loan-approval-chain", productCode] as const,
};

export function useLoanApprovals(loanIdOrNumber: string | null) {
  return useQuery({
    queryKey: loanApprovalKeys.forLoan(loanIdOrNumber ?? ""),
    queryFn: () =>
      getApiClient().get<LoanApproval[]>(`/loans/${loanIdOrNumber}/approvals`),
    // Don't bother fetching when there's no loan id yet.
    enabled: !!loanIdOrNumber,
    // Short stale time — approvals can change rapidly while multiple
    // approvers are clicking through the chain in different tabs.
    staleTime: 5_000,
  });
}

export interface ApproveInput {
  notes?: string;
}

export function useApproveStep(loanIdOrNumber: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ApproveInput) =>
      getApiClient().post<LoanApprovalActionResult>(
        `/loans/${loanIdOrNumber}/approvals`,
        input ?? {},
      ),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: loanApprovalKeys.forLoan(loanIdOrNumber),
      });
      // Loan detail caches everywhere need the updated status + step.
      void qc.invalidateQueries({ queryKey: ["loans"] });
    },
  });
}

export interface RejectInput {
  notes: string;
}

export function useRejectStep(loanIdOrNumber: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RejectInput) =>
      getApiClient().post<LoanApproval>(
        `/loans/${loanIdOrNumber}/approvals/reject`,
        input,
      ),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: loanApprovalKeys.forLoan(loanIdOrNumber),
      });
      void qc.invalidateQueries({ queryKey: ["loans"] });
    },
  });
}

export function useApprovalChain(productCode: string | null) {
  return useQuery({
    queryKey: loanApprovalKeys.chain(productCode ?? ""),
    queryFn: () =>
      getApiClient().get<LoanApprovalStep[]>(
        `/loan-products/${productCode}/approval-chain`,
      ),
    enabled: !!productCode,
    staleTime: 60_000,
  });
}

export function useUpdateApprovalChain(productCode: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (steps: LoanApprovalStepInput[]) =>
      getApiClient().request<LoanApprovalStep[]>(
        `/loan-products/${productCode}/approval-chain`,
        {
          method: "PUT",
          body: JSON.stringify({ steps }),
        },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: loanApprovalKeys.chain(productCode),
      });
    },
  });
}
