import type {
  MePermissions,
  Permission,
  Role,
  RoleCreateInput,
  RoleUpdateInput,
  RoleWithPermissions,
  UserWithRoles,
} from '@loan/shared-types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { getApiClient } from '../client.js';

export const rbacKeys = {
  permissions: ['rbac', 'permissions'] as const,
  roles: ['rbac', 'roles'] as const,
  role: (key: string) => ['rbac', 'roles', key] as const,
  users: ['rbac', 'users'] as const,
  mePermissions: ['rbac', 'me-permissions'] as const,
};

export function usePermissions() {
  return useQuery({
    queryKey: rbacKeys.permissions,
    queryFn: () => getApiClient().get<Permission[]>('/admin/permissions'),
  });
}

export function useRoles() {
  return useQuery({
    queryKey: rbacKeys.roles,
    queryFn: () => getApiClient().get<RoleWithPermissions[]>('/admin/roles'),
  });
}

export function useRole(key: string | null) {
  return useQuery({
    queryKey: rbacKeys.role(key ?? ''),
    queryFn: () => getApiClient().get<RoleWithPermissions>(`/admin/roles/${key}`),
    enabled: Boolean(key),
  });
}

export function useCreateRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RoleCreateInput) =>
      getApiClient().post<Role>('/admin/roles', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: rbacKeys.roles }),
  });
}

export function useUpdateRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { key: string } & RoleUpdateInput) => {
      const { key, ...rest } = input;
      return getApiClient().request<Role>(`/admin/roles/${key}`, {
        method: 'PATCH',
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
      getApiClient().request<Role>(`/admin/roles/${key}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: rbacKeys.roles }),
  });
}

export function useUsers() {
  return useQuery({
    queryKey: rbacKeys.users,
    queryFn: () => getApiClient().get<UserWithRoles[]>('/admin/users'),
  });
}

export function useAssignRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: string; roleKey: string }) =>
      getApiClient().post(`/admin/users/${input.userId}/roles`, { roleKey: input.roleKey }),
    onSuccess: () => qc.invalidateQueries({ queryKey: rbacKeys.users }),
  });
}

export function useUnassignRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: string; roleKey: string }) =>
      getApiClient().request(`/admin/users/${input.userId}/roles/${input.roleKey}`, {
        method: 'DELETE',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: rbacKeys.users }),
  });
}

export function useMyPermissions() {
  return useQuery({
    queryKey: rbacKeys.mePermissions,
    queryFn: () => getApiClient().get<MePermissions>('/auth/me/permissions'),
    staleTime: 60_000,
  });
}
