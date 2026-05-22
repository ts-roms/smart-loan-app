import type { LicenseStatusPayload } from "@loan/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getApiClient } from "../client";

/**
 * Licensing hooks. Three operations, all under /license:
 *
 *   - useLicenseStatus()    poll the current status (open to any
 *                           authed user; the dashboard banner uses it).
 *   - useActivateLicense()  paste a token + persist. ADMIN-gated server
 *                           side via admin.roles.
 *   - useDeactivateLicense() clear the current license. Same gate.
 */

export const licenseKeys = {
  status: ["license", "status"] as const,
};

/**
 * Status of the active license — read-mostly, refreshes every 5 min
 * so a banner like "expires in 12 days" stays current without manual
 * refresh.
 */
export function useLicenseStatus() {
  return useQuery({
    queryKey: licenseKeys.status,
    queryFn: () => getApiClient().get<LicenseStatusPayload>("/license/status"),
    // Background poll keeps "X days until expiry" honest on long
    // sessions without making every page render block on it.
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });
}

/**
 * Activate a pasted token. On success we invalidate the status query
 * so the UI flips from NONE/EXPIRED to ACTIVE without a manual reload.
 */
export function useActivateLicense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { token: string }) =>
      getApiClient().post<LicenseStatusPayload>("/license/activate", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: licenseKeys.status }),
  });
}

/**
 * Clear the active license. Server marks the row revoked; the next
 * status poll returns NONE. Idempotent — calling deactivate when
 * nothing is active is not an error.
 */
export function useDeactivateLicense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      getApiClient().post<{ ok: true; revokedId: string | null }>(
        "/license/deactivate",
        {},
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: licenseKeys.status }),
  });
}
