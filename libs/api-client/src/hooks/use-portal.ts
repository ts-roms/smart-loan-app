import type {
  Customer,
  KycDocumentType,
  KycSubmission,
  KycValidationResult,
  LoanApplication,
  LoanApplyInput,
  PaymentIntent,
} from "@loan/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getApiClient } from "../client.js";
import type { Contribution, SavingsTransaction } from "./use-cooperative.js";

export const portalKeys = {
  me: ["portal", "me"] as const,
  loans: ["portal", "loans"] as const,
  loan: (id: string) => ["portal", "loans", id] as const,
  kyc: ["portal", "kyc"] as const,
  ledger: ["portal", "member-ledger"] as const,
  contributions: ["portal", "contributions"] as const,
  savings: ["portal", "savings"] as const,
};

export interface PortalMe {
  customer: Customer;
  score: { score: number; tier: string; computedAt: string } | null;
}

export function usePortalMe() {
  return useQuery({
    queryKey: portalKeys.me,
    queryFn: () => getApiClient().get<PortalMe>("/portal/me"),
  });
}

export function usePortalLoans() {
  return useQuery({
    queryKey: portalKeys.loans,
    queryFn: () => getApiClient().get<LoanApplication[]>("/portal/loans"),
  });
}

export function usePortalLoan(id: string | null) {
  return useQuery({
    queryKey: portalKeys.loan(id ?? ""),
    queryFn: () => getApiClient().get<LoanApplication>(`/portal/loans/${id}`),
    enabled: Boolean(id),
  });
}

export function usePortalApplyLoan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<LoanApplyInput, "customerId">) =>
      getApiClient().post<LoanApplication>("/portal/loans/apply", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: portalKeys.loans }),
  });
}

export interface PortalKycResponse {
  docs: KycSubmission[];
  status: KycValidationResult;
}

export function usePortalKyc() {
  return useQuery({
    queryKey: portalKeys.kyc,
    queryFn: () => getApiClient().get<PortalKycResponse>("/portal/kyc"),
  });
}

export function usePortalSubmitKyc() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      documentType: KycDocumentType;
      documentUrl: string;
      notes?: string;
    }) => getApiClient().post<KycSubmission>("/portal/kyc", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: portalKeys.kyc }),
  });
}

export function usePortalCreatePaymentIntent() {
  return useMutation({
    mutationFn: (input: { loanId: string; amount: number }) =>
      getApiClient().post<PaymentIntent>("/portal/payments/intents", input),
  });
}

export function usePortalPaymentIntent(
  id: string | null,
  opts?: { refetchInterval?: number },
) {
  return useQuery({
    queryKey: ["portal", "payment-intent", id ?? ""],
    queryFn: () =>
      getApiClient().get<PaymentIntent>(`/portal/payments/intents/${id}`),
    enabled: Boolean(id),
    refetchInterval: opts?.refetchInterval,
  });
}

// ─── Cooperative member views ─────────────────────────────────────

/**
 * Lifetime totals (CBU / Mortuary / Emergency / savings net) plus
 * recent activity. Backs the dashboard widget AND the contributions /
 * savings page summary cards.
 */
export interface PortalMemberLedger {
  customer: {
    id: string;
    firstName: string;
    middleName: string | null;
    lastName: string;
    email: string | null;
    phone: string;
    governmentIdType: string;
    governmentIdNumber: string;
  };
  totals: {
    capitalBuildUp: number;
    mortuaryFund: number;
    emergencyFund: number;
    contributionsCount: number;
    savingsNet: number;
    savingsDeposits: number;
    savingsWithdrawals: number;
    savingsCount: number;
  };
  recentContributions: Contribution[];
  recentSavings: SavingsTransaction[];
}

export function usePortalMemberLedger() {
  return useQuery({
    queryKey: portalKeys.ledger,
    queryFn: () =>
      getApiClient().get<PortalMemberLedger>("/portal/member-ledger"),
    staleTime: 30_000,
  });
}

export function usePortalContributions() {
  return useQuery({
    queryKey: portalKeys.contributions,
    queryFn: () => getApiClient().get<Contribution[]>("/portal/contributions"),
  });
}

export function usePortalSavings() {
  return useQuery({
    queryKey: portalKeys.savings,
    queryFn: () => getApiClient().get<SavingsTransaction[]>("/portal/savings"),
  });
}

// ─── Profile self-edit ───────────────────────────────────────────

/**
 * Allowlist-style profile update. Only contact + address fields. Names,
 * date of birth, gov't ID, employment, KYC status — none of those are
 * editable here (officer-only). The api enforces the allowlist again
 * server-side; this type just documents what the UI lets you change.
 */
export interface PortalProfileUpdate {
  phone?: string;
  email?: string | null;
  address?: string;
  city?: string;
  province?: string | null;
  postalCode?: string | null;
}

export function usePortalUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: PortalProfileUpdate) =>
      getApiClient().request<Customer>("/portal/me", {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: portalKeys.me }),
  });
}
