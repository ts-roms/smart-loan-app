import {
  useActiveDelegations,
  useDelegationUserDirectory,
  type DelegationUserEntry,
} from '@loan/api-client';
import { formatDate } from '@loan/shared-utils';
import { ShieldCheck } from 'lucide-react';

/**
 * Amber banner rendered at the top of every staff page when the caller
 * holds one or more active delegations. Tells them exactly which proxy
 * authority they're acting under and from whom — so an accountant signing
 * a loan under an officer's delegation knows it's being recorded that way.
 */
export function ActiveDelegationBanner() {
  const active = useActiveDelegations();
  const users = useDelegationUserDirectory();
  if (!active.data || active.data.length === 0) return null;
  const userById = new Map<string, DelegationUserEntry>();
  for (const u of users.data ?? []) userById.set(u.id, u);

  return (
    <div className="rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
      <div className="flex items-center gap-2 font-medium">
        <ShieldCheck className="h-3 w-3" />
        Acting under {active.data.length} active delegation
        {active.data.length === 1 ? '' : 's'}
      </div>
      <ul className="mt-1 space-y-0.5 pl-5 list-disc">
        {active.data.map((d) => {
          const from = userById.get(d.delegatorId);
          return (
            <li key={d.id}>
              from <strong>{from?.name ?? d.delegatorId.slice(0, 8)}</strong> ·{' '}
              {d.permissions.length === 0
                ? 'all permissions'
                : `${d.permissions.length} permission${d.permissions.length === 1 ? '' : 's'}`}{' '}
              · until {formatDate(d.endsAt)}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
