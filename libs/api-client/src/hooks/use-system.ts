/**
 * System-wide settings. Today: idle-then-logout policy. Hosts more
 * cross-cutting toggles as they're added (e.g. password rotation).
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getApiClient } from "../client";

/**
 * Org-wide policy as the API reports it. The `bounds` field tells the
 * frontend the per-field min/max so settings inputs can clamp + show
 * helpful hints without duplicating the values.
 */
export interface IdlePolicy {
  idleTimeoutSeconds: number;
  idleWarningSeconds: number;
  updatedAt: string;
  bounds: {
    idleTimeoutSeconds: { min: number; max: number };
    idleWarningSeconds: { min: number; max: number };
  };
}

export interface IdlePolicyUpdateInput {
  idleTimeoutSeconds: number;
  idleWarningSeconds: number;
}

export const systemKeys = {
  idlePolicy: ["system", "idle-policy"] as const,
  branding: ["system", "branding"] as const,
};

/**
 * Company branding — name, logo, contact details. Surfaced in the
 * shell sidebar, document.title, PDF letterheads, and notification
 * templates. All non-name fields are optional.
 */
export interface CompanyBranding {
  companyName: string;
  companyLogoUrl: string | null;
  companyTagline: string | null;
  companyAddress: string | null;
  companyPhone: string | null;
  companyEmail: string | null;
  companyWebsite: string | null;
  updatedAt: string;
}

export interface CompanyBrandingUpdateInput {
  companyName: string;
  companyLogoUrl?: string | null;
  companyTagline?: string | null;
  companyAddress?: string | null;
  companyPhone?: string | null;
  companyEmail?: string | null;
  companyWebsite?: string | null;
}

/**
 * Read the org-wide idle-logout policy. Any authenticated user can hit
 * this — the frontend needs the values to wire its activity listener.
 *
 * Cached aggressively (1h staleTime) because policy changes are rare;
 * updates invalidate the key via `useUpdateIdlePolicy`.
 */
export function useIdlePolicy() {
  return useQuery({
    queryKey: systemKeys.idlePolicy,
    queryFn: () => getApiClient().get<IdlePolicy>("/system/idle-policy"),
    staleTime: 60 * 60 * 1000,
  });
}

/**
 * Admin-only mutation. Server enforces the `admin.system_config`
 * permission gate and clamps to the API's safety bounds, so the UI
 * caller doesn't need to re-check role here.
 */
/**
 * Read the live branding config. Any authenticated user can read so the
 * shell can render the configured name + logo. 1-hour staleTime — brand
 * changes are rare so we don't pay roundtrip on every navigation.
 */
export function useBranding() {
  return useQuery({
    queryKey: systemKeys.branding,
    queryFn: () => getApiClient().get<CompanyBranding>("/system/branding"),
    staleTime: 60 * 60 * 1000,
  });
}

/** Admin mutation. Server enforces admin.system_config + audit logs. */
export function useUpdateBranding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CompanyBrandingUpdateInput) =>
      getApiClient().request<CompanyBranding>("/system/branding", {
        method: "PUT",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: systemKeys.branding });
    },
  });
}

export function useUpdateIdlePolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: IdlePolicyUpdateInput) =>
      // ApiClient exposes the lower-level `request` for non-GET/POST verbs.
      getApiClient().request<IdlePolicy>("/system/idle-policy", {
        method: "PUT",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: systemKeys.idlePolicy });
    },
  });
}

// ─── Effective policy (org + per-user override) ───────────────────────
//
// Per-user override lives in localStorage. The user can be stricter than
// the org policy but never longer. We clamp at read time so a stale
// localStorage value doesn't outlast a tightened org ceiling.

const STORAGE_KEY = "smartloan.idle.override.v1";

interface UserIdleOverride {
  idleTimeoutSeconds?: number;
  idleWarningSeconds?: number;
}

/**
 * Read the per-user override from localStorage. Returns an empty object
 * if nothing is stored — safe to spread.
 */
export function readUserIdleOverride(): UserIdleOverride {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return {
      idleTimeoutSeconds:
        typeof parsed?.idleTimeoutSeconds === "number"
          ? parsed.idleTimeoutSeconds
          : undefined,
      idleWarningSeconds:
        typeof parsed?.idleWarningSeconds === "number"
          ? parsed.idleWarningSeconds
          : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Persist a per-user override. Pass null/undefined for a field to clear
 * just that field; pass an empty object to clear both.
 */
export function writeUserIdleOverride(input: UserIdleOverride): void {
  if (typeof window === "undefined") return;
  const current = readUserIdleOverride();
  const next = { ...current, ...input };
  // Drop undefined keys so the JSON is tidy.
  const cleaned: UserIdleOverride = {};
  if (typeof next.idleTimeoutSeconds === "number") {
    cleaned.idleTimeoutSeconds = next.idleTimeoutSeconds;
  }
  if (typeof next.idleWarningSeconds === "number") {
    cleaned.idleWarningSeconds = next.idleWarningSeconds;
  }
  if (!cleaned.idleTimeoutSeconds && !cleaned.idleWarningSeconds) {
    window.localStorage.removeItem(STORAGE_KEY);
  } else {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
  }
}

export function clearUserIdleOverride(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(STORAGE_KEY);
}

export interface EffectiveIdlePolicy {
  idleTimeoutSeconds: number;
  idleWarningSeconds: number;
  /** Source of truth for the active values. */
  source: {
    idleTimeoutSeconds: "org" | "user";
    idleWarningSeconds: "org" | "user";
  };
  /** Raw inputs so the settings UI can show "you've set 30s" vs "org default". */
  org: IdlePolicy | null;
  user: UserIdleOverride;
  /** True until org policy resolves; callers can no-op until then. */
  isLoading: boolean;
}

/**
 * Merge org policy with the local per-user override.
 *
 * Per-user can only be *stricter* (smaller). A larger user value would
 * relax the org ceiling, which defeats the point of having one — so we
 * silently clamp. The UI surfaces this to the user with a hint instead
 * of letting it slip by.
 */
export function useEffectiveIdlePolicy(): EffectiveIdlePolicy {
  const policy = useIdlePolicy();
  const user = readUserIdleOverride();

  if (!policy.data) {
    return {
      idleTimeoutSeconds: 60,
      idleWarningSeconds: 60,
      source: { idleTimeoutSeconds: "org", idleWarningSeconds: "org" },
      org: null,
      user,
      isLoading: true,
    };
  }

  const orgTimeout = policy.data.idleTimeoutSeconds;
  const orgWarn = policy.data.idleWarningSeconds;

  // Clamp user override to org max (stricter only, never longer).
  const userTimeout =
    typeof user.idleTimeoutSeconds === "number"
      ? Math.min(user.idleTimeoutSeconds, orgTimeout)
      : undefined;
  const userWarn =
    typeof user.idleWarningSeconds === "number"
      ? Math.min(user.idleWarningSeconds, orgWarn)
      : undefined;

  return {
    idleTimeoutSeconds: userTimeout ?? orgTimeout,
    idleWarningSeconds: userWarn ?? orgWarn,
    source: {
      idleTimeoutSeconds: typeof userTimeout === "number" ? "user" : "org",
      idleWarningSeconds: typeof userWarn === "number" ? "user" : "org",
    },
    org: policy.data,
    user,
    isLoading: false,
  };
}
