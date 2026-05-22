import type {
  BulkUserImportInput,
  BulkUserImportResponse,
  MePermissions,
  Permission,
  PermissionHoldersPayload,
  Role,
  RoleCreateInput,
  RoleEditImpact,
  RoleUpdateInput,
  RoleWithPermissions,
  UserWithRoles,
} from "@loan/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getApiClient } from "../client.js";

export const rbacKeys = {
  permissions: ["rbac", "permissions"] as const,
  roles: ["rbac", "roles"] as const,
  role: (key: string) => ["rbac", "roles", key] as const,
  users: ["rbac", "users"] as const,
  mePermissions: ["rbac", "me-permissions"] as const,
  permissionHolders: (key: string) =>
    ["rbac", "permission-holders", key] as const,
};

export function usePermissions() {
  return useQuery({
    queryKey: rbacKeys.permissions,
    queryFn: () => getApiClient().get<Permission[]>("/admin/permissions"),
  });
}

export function useRoles() {
  return useQuery({
    queryKey: rbacKeys.roles,
    queryFn: () => getApiClient().get<RoleWithPermissions[]>("/admin/roles"),
  });
}

export function useRole(key: string | null) {
  return useQuery({
    queryKey: rbacKeys.role(key ?? ""),
    queryFn: () =>
      getApiClient().get<RoleWithPermissions>(`/admin/roles/${key}`),
    enabled: Boolean(key),
  });
}

export function useCreateRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RoleCreateInput) =>
      getApiClient().post<Role>("/admin/roles", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: rbacKeys.roles }),
  });
}

export function useUpdateRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { key: string } & RoleUpdateInput) => {
      const { key, ...rest } = input;
      return getApiClient().request<Role>(`/admin/roles/${key}`, {
        method: "PATCH",
        body: JSON.stringify(rest),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: rbacKeys.roles }),
  });
}

export function useDeleteRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) =>
      getApiClient().request<Role>(`/admin/roles/${key}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: rbacKeys.roles }),
  });
}

export function useUsers() {
  return useQuery({
    queryKey: rbacKeys.users,
    queryFn: () => getApiClient().get<UserWithRoles[]>("/admin/users"),
  });
}

export interface CreateUserInput {
  email: string;
  name: string;
  password: string;
  role: "ADMIN" | "LOAN_OFFICER" | "ACCOUNTANT" | "CUSTOMER";
  /** Required when role === 'CUSTOMER' to link to an existing customer row. */
  customerId?: string;
}

export interface CreatedUser {
  id: string;
  email: string;
  name: string;
  role: "ADMIN" | "LOAN_OFFICER" | "ACCOUNTANT" | "CUSTOMER";
  active: boolean;
  createdAt: string;
  customerId: string | null;
}

/**
 * Admin-side user creation. Distinct from the public /auth/register
 * endpoint, which creates CUSTOMER-only users and is rate-limited;
 * this one lets an ADMIN seed staff (ADMIN / LOAN_OFFICER / ACCOUNTANT)
 * or link a customer-portal login to an existing Customer row.
 */
export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateUserInput) =>
      getApiClient().post<CreatedUser>("/admin/users", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: rbacKeys.users }),
  });
}

export function useAssignRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: string; roleKey: string }) =>
      getApiClient().post(`/admin/users/${input.userId}/roles`, {
        roleKey: input.roleKey,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: rbacKeys.users }),
  });
}

/**
 * Bulk user onboarding via CSV. Returns a 207 Multi-Status payload
 * even on partial failures — the page renders both `succeeded` and
 * `failed` rows. Only invalidates the user list when at least one row
 * actually committed (dry-run + all-failed runs don't change DB state).
 */
export function useBulkImportUsers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BulkUserImportInput) =>
      getApiClient().post<BulkUserImportResponse>(
        "/admin/users/bulk-import",
        input,
      ),
    onSuccess: (data) => {
      if (!data.dryRun && data.succeeded > 0) {
        qc.invalidateQueries({ queryKey: rbacKeys.users });
      }
    },
  });
}

export function useUnassignRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: string; roleKey: string }) =>
      getApiClient().request(
        `/admin/users/${input.userId}/roles/${input.roleKey}`,
        {
          method: "DELETE",
        },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: rbacKeys.users }),
  });
}

export function useMyPermissions() {
  return useQuery({
    queryKey: rbacKeys.mePermissions,
    queryFn: () => getApiClient().get<MePermissions>("/auth/me/permissions"),
    staleTime: 60_000,
  });
}

/**
 * Pre-flight check for a role edit. Computes the user-loss count per
 * permission being removed so the UI can show a confirmation dialog
 * before saving the actual update. Imperative mutation rather than a
 * query because the inputs (permission list) come from a live form
 * and we want the call to fire exactly when Save is clicked.
 */
export function useRoleEditImpact() {
  return useMutation({
    mutationFn: (input: { roleKey: string; permissions: string[] }) =>
      getApiClient().post<RoleEditImpact>(
        `/admin/roles/${input.roleKey}/edit-impact`,
        { permissions: input.permissions },
      ),
  });
}

/**
 * Reverse permission lookup. Returns roles + active delegations
 * currently granting the key, with a deduped active-user count.
 * Drives the "who has X?" search box on the roles admin page.
 * `enabled` gate keeps the query idle until the user actually picks
 * a key — search-as-you-type would fire one request per keystroke.
 */
export function usePermissionHolders(key: string | null) {
  return useQuery({
    queryKey: rbacKeys.permissionHolders(key ?? ""),
    queryFn: () =>
      getApiClient().get<PermissionHoldersPayload>(
        `/admin/permissions/${key}/holders`,
      ),
    enabled: Boolean(key),
    // Active-user counts change with role assignments; stale-while-
    // revalidate at 30s keeps the answer fresh without thrashing.
    staleTime: 30_000,
  });
}
