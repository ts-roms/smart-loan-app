import type { UserRole } from "@loan/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getApiClient } from "../client";

export interface LoggedInUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  /**
   * Borrower record attached to this login, or null.
   *
   * A CUSTOMER with null here registered but hasn't completed their
   * profile — every portal endpoint will refuse them until they do.
   * The web app treats that as a hard gate rather than a nudge, so
   * check this before routing a borrower anywhere else.
   *
   * Always null for staff, who have no borrower record.
   */
  customerId: string | null;
}

export interface LoginResponse {
  /** Back-compat alias for accessToken — older clients used this name. */
  token: string;
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  user: LoggedInUser;
}

export function useLogin() {
  return useMutation({
    mutationFn: (input: {
      email: string;
      password: string;
      /**
       * Tenant slug for multi-tenant deployments. In single-tenant
       * mode (the default during the Phase 2 conversion) the server
       * ignores this and uses DEFAULT_TENANT_SLUG. The web app reads
       * the slug from `?tenant=<slug>` on the login URL and forwards
       * it here.
       */
      tenantSlug?: string;
      totpCode?: string;
      recoveryCode?: string;
    }) => getApiClient().post<LoginResponse>("/auth/login", input),
  });
}

export function useRegister() {
  return useMutation({
    mutationFn: (input: {
      email: string;
      password: string;
      name: string;
      tenantSlug?: string;
    }) => getApiClient().post<LoginResponse>("/auth/register", input),
  });
}

/** Fields the borrower fills in on the profile-completion screen. */
export interface CompleteProfileInput {
  firstName: string;
  middleName?: string;
  lastName: string;
  suffix?: string;
  /** YYYY-MM-DD. Date-only on purpose — see the server-side schema. */
  dateOfBirth: string;
  civilStatus?:
    "SINGLE" | "MARRIED" | "WIDOWED" | "SEPARATED" | "ANNULLED" | "DIVORCED";
  phone: string;
  secondaryPhone?: string;
  email?: string;
  address: string;
  addressLine2?: string;
  barangay?: string;
  city: string;
  province?: string;
  region?: string;
  postalCode?: string;
  governmentIdType:
    "PASSPORT" | "DRIVERS_LICENSE" | "NATIONAL_ID" | "SSS" | "TIN" | "OTHER";
  governmentIdNumber: string;
  employmentStatus:
    | "EMPLOYED"
    | "SELF_EMPLOYED"
    | "FREELANCE"
    | "UNEMPLOYED"
    | "RETIRED"
    | "STUDENT";
  employerName?: string;
  jobTitle?: string;
  monthlyIncome: number;
}

/**
 * Create the borrower record for a freshly-registered account. On
 * success the returned user carries a non-null `customerId`, which is
 * what lifts the portal gate — callers should feed it straight back
 * into their auth state rather than waiting for the next /auth/me.
 */
export function useCompleteProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CompleteProfileInput) =>
      getApiClient().post<{ user: LoggedInUser }>("/auth/me/profile", input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["auth", "me"] });
    },
  });
}

/**
 * Exchange a refresh token for a new access+refresh pair. The tenant
 * slug must be carried alongside — refresh tokens live in the
 * tenant's RefreshToken table, so the server needs to know which
 * schema to read from.
 */
export async function refreshSession(
  refreshToken: string,
  tenantSlug?: string,
): Promise<LoginResponse> {
  return getApiClient().post<LoginResponse>("/auth/refresh", {
    refreshToken,
    ...(tenantSlug ? { tenantSlug } : {}),
  });
}

/** Revoke the current refresh token (logout). */
export async function logoutSession(refreshToken: string): Promise<void> {
  await getApiClient().post("/auth/logout", { refreshToken });
}

export function useMyProfile() {
  return useQuery({
    queryKey: ["auth", "me"],
    queryFn: () =>
      getApiClient().get<LoggedInUser & { active: boolean; createdAt: string }>(
        "/auth/me",
      ),
  });
}

export interface MySignature {
  signatureUrl: string | null;
  savedAt: string | null;
}

export const mySignatureKey = ["auth", "me-signature"] as const;

/** Caller's saved personnel signature (drives the "My Signature" UI). */
export function useMySignature() {
  return useQuery({
    queryKey: mySignatureKey,
    queryFn: () => getApiClient().get<MySignature>("/auth/me/signature"),
    staleTime: 60_000,
  });
}

export function useSaveMySignature() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { signatureUrl: string }) =>
      getApiClient().request<MySignature>("/auth/me/signature", {
        method: "PUT",
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: mySignatureKey }),
  });
}

export function useClearMySignature() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      getApiClient().request<MySignature>("/auth/me/signature", {
        method: "DELETE",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: mySignatureKey }),
  });
}

export interface MyNotificationState {
  lastSeenAt: string | null;
  unseen: number;
}

export const myNotificationStateKey = ["auth", "me-notif-state"] as const;

/** Notification "mark-as-read" cursor + unseen count. Drives the bell badge. */
export function useMyNotificationState() {
  return useQuery({
    queryKey: myNotificationStateKey,
    queryFn: () =>
      getApiClient().get<MyNotificationState>("/auth/me/notifications/state"),
    staleTime: 15_000,
    // Refetch when the tab regains focus so the badge stays roughly fresh.
    refetchOnWindowFocus: true,
  });
}

export function useMarkNotificationsSeen() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      getApiClient().post<MyNotificationState>(
        "/auth/me/notifications/seen",
        {},
      ),
    onSuccess: (data) => {
      qc.setQueryData(myNotificationStateKey, data);
    },
  });
}

// ─── 2FA (TOTP) ───────────────────────────────────────────────────

export interface TwoFactorStatus {
  enabled: boolean;
  recoveryCodesRemaining: number;
}

export interface TwoFactorSetup {
  secret: string;
  otpauth: string;
}

export interface TwoFactorEnableResult {
  enabled: true;
  recoveryCodes: string[];
}

export const twoFactorStatusKey = ["auth", "me-2fa-status"] as const;

export function useTwoFactorStatus() {
  return useQuery({
    queryKey: twoFactorStatusKey,
    queryFn: () => getApiClient().get<TwoFactorStatus>("/auth/me/2fa/status"),
  });
}

export function useStartTwoFactorSetup() {
  return useMutation({
    mutationFn: () =>
      getApiClient().post<TwoFactorSetup>("/auth/me/2fa/setup", {}),
  });
}

export function useEnableTwoFactor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (code: string) =>
      getApiClient().post<TwoFactorEnableResult>("/auth/me/2fa/enable", {
        code,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: twoFactorStatusKey }),
  });
}

export function useDisableTwoFactor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (code: string) =>
      getApiClient().post<{ enabled: false }>("/auth/me/2fa/disable", { code }),
    onSuccess: () => qc.invalidateQueries({ queryKey: twoFactorStatusKey }),
  });
}

/**
 * Password reset.
 *
 * `useForgotPassword` never reports whether the address matched — the
 * API answers 202 either way, by design, so the UI must show the same
 * confirmation regardless. Anything else would leak what the endpoint
 * is careful not to.
 */
export function useForgotPassword() {
  return useMutation({
    mutationFn: (input: { email: string; tenantSlug?: string }) =>
      getApiClient().post<{ ok: true }>("/auth/forgot-password", input),
  });
}

/** Is this reset link still redeemable? Checked when the page opens. */
export function useResetTokenStatus(token: string) {
  return useQuery({
    queryKey: ["auth", "reset-token", token],
    queryFn: () =>
      getApiClient().get<{ ok: true }>(`/auth/reset-password/${token}`),
    enabled: Boolean(token),
    retry: false,
  });
}

export function useResetPassword() {
  return useMutation({
    mutationFn: (input: { token: string; password: string }) =>
      getApiClient().post<{ ok: true }>("/auth/reset-password", input),
  });
}
