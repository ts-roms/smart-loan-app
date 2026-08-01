import { useCustomers } from "@loan/api-client";
import type { Customer } from "@loan/shared-types";
import { SearchInput } from "@loan/ui";
import { useMemo } from "react";

/**
 * Reusable member picker. Wraps the shared `<SearchInput>` primitive so
 * the typeahead-on-demand floating dropdown, keyboard nav, click-outside,
 * and clear behaviours all stay in one place.
 *
 * Lives in `components/` (not under any single feature) because it is
 * needed by multiple feature folders — cooperative, dorsi, and likely
 * any future surface that has to bind an operator's action to a specific
 * customer without typing a UUID.
 *
 * Contract:
 *
 *   <CustomerPicker value={customerId} onChange={setCustomerId} />
 *
 * `value` is the customer UUID; `onChange` receives the UUID (or empty
 * string when cleared). The picker resolves the full customer object
 * internally for the floating dropdown's per-row markup.
 */
export function CustomerPicker({
  value,
  onChange,
  placeholder = "Search by name, email, ID, or reference",
}: {
  value: string;
  onChange: (id: string) => void;
  required?: boolean;
  placeholder?: string;
}) {
  const customers = useCustomers();
  // Memoized because `?? []` allocates a fresh array on every render while
  // the query is loading, which would change the `selected` memo's deps
  // each pass and defeat it entirely.
  const rows = useMemo(() => customers.data ?? [], [customers.data]);

  // Resolve the currently-selected customer (if any) so SearchInput can
  // render its label inside the input once chosen.
  const selected = useMemo(
    () => (value ? (rows.find((c) => c.id === value) ?? null) : null),
    [rows, value],
  );

  return (
    <SearchInput<Customer>
      items={rows}
      value={selected}
      onSelect={(c) => onChange(c?.id ?? "")}
      matches={(c, q) =>
        c.firstName.toLowerCase().includes(q) ||
        c.lastName.toLowerCase().includes(q) ||
        (c.email ?? "").toLowerCase().includes(q) ||
        c.governmentIdNumber.toLowerCase().includes(q) ||
        (c.number ?? "").toLowerCase().includes(q)
      }
      getDisplayLabel={(c) => `${c.firstName} ${c.lastName}`}
      getItemKey={(c) => c.id}
      // Operators usually reach for the same handful of members, so open
      // with a starting set instead of an empty field they have to guess at.
      suggestOnFocus
      maxResults={10}
      placeholder={placeholder}
      emptyMessage={(q) => `No customers match “${q}”.`}
      renderSuggestion={(c) => (
        <span className="flex items-center justify-between gap-3 min-w-0">
          <span className="min-w-0 truncate">
            {c.firstName} {c.lastName}
          </span>
          <span className="flex items-center gap-2 shrink-0 text-[10px] font-mono text-fg-subtle">
            {c.number && <span>{c.number}</span>}
            <span>
              {c.governmentIdType} {c.governmentIdNumber}
            </span>
          </span>
        </span>
      )}
    />
  );
}
