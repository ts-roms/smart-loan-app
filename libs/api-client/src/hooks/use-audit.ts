/**
 * Audit log hooks. Read-only; entries are appended server-side from each
 * privileged route via AuditLogRepository.record().
 */

import type { AuditEventFilter, AuditEventRow } from '@loan/shared-types';
import { useQuery } from '@tanstack/react-query';

import { getApiClient } from '../client.js';

export const auditKeys = {
  list: (filter: AuditEventFilter) => ['audit', 'list', filter] as const,
  actions: ['audit', 'distinct-actions'] as const,
};

export function useAuditEvents(filter: AuditEventFilter = {}, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: auditKeys.list(filter),
    queryFn: () => {
      const params = new URLSearchParams();
      if (filter.actorId) params.set('actorId', filter.actorId);
      if (filter.action) params.set('action', filter.action);
      if (filter.targetType) params.set('targetType', filter.targetType);
      if (filter.targetId) params.set('targetId', filter.targetId);
      if (filter.from) params.set('from', filter.from);
      if (filter.to) params.set('to', filter.to);
      if (filter.take) params.set('take', String(filter.take));
      const qs = params.toString();
      return getApiClient().get<AuditEventRow[]>(`/audit${qs ? `?${qs}` : ''}`);
    },
    enabled: options?.enabled ?? true,
    staleTime: 15_000,
  });
}

export function useAuditActions(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: auditKeys.actions,
    queryFn: () => getApiClient().get<string[]>('/audit/distinct/actions'),
    enabled: options?.enabled ?? true,
    staleTime: 5 * 60_000,
  });
}
