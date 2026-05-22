import type { UserRole } from "@loan/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getApiClient } from "../client";

export interface LoggedInUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
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
      totpCode?: string;
      recoveryCode?: string;
    }) => getApiClient().post<LoginResponse>("/auth/login", input),
  });
}

export function useRegister() {
  return useMutation({
    mutationFn: (input: { email: string; password: string; name: string }) =>
      getApiClient().post<LoginResponse>("/auth/register", input),
  });
}

/** Exchange a refresh token for a new access+refresh pair. */
export async function refreshSession(
  refreshToken: string,
): Promise<LoginResponse> {
  return getApiClient().post<LoginResponse>("/auth/refresh", { refreshToken });
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
