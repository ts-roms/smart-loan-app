import { useCustomers } from '@loan/api-client';
import { cn } from '@loan/ui';
import { useMemo, useState } from 'react';

/**
 * Lightweight customer search + select for cooperative dialogs.
 *
 * Wraps useCustomers with a simple substring filter, rendered as a search
 * input over a scrollable list. We don't use Radix Select here because the
 * list can be hundreds of rows and we need a permanent type-to-filter UX —
 * a native combobox / listbox is the right shape, just styled by hand to
 * match the rest of the dark theme.
 */
export function CustomerPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
  required?: boolean;
}) {
  const customers = useCustomers();
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const rows = customers.data ?? [];
    if (!query) return rows.slice(0, 50);
    const q = query.toLowerCase();
    return rows
      .filter(
        (c) =>
          c.firstName.toLowerCase().includes(q) ||
          c.lastName.toLowerCase().includes(q) ||
          (c.email ?? '').toLowerCase().includes(q) ||
          c.governmentIdNumber.toLowerCase().includes(q),
      )
      .slice(0, 50);
  }, [customers.data, query]);

  return (
    <div className="space-y-1">
      <input
        type="text"
        placeholder="Search by name, email, or ID number"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="w-full rounded-md border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-white placeholder:text-white/45 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60"
      />
      <div className="max-h-48 overflow-y-auto rounded-md border border-white/10 bg-slate-950/40">
        {filtered.length === 0 ? (
          <div className="px-3 py-2 text-xs text-white/55">No customers match.</div>
        ) : (
          filtered.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onChange(c.id)}
              className={cn(
                'flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-white/[0.06]',
                value === c.id && 'bg-sky-500/15 text-white',
              )}
            >
              <span>
                {c.firstName} {c.lastName}
              </span>
              <span className="font-mono text-[10px] text-white/55">
                {c.governmentIdType} {c.governmentIdNumber}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
