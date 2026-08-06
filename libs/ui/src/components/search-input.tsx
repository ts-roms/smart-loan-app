import { Check, ChevronDown, Search, X } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cn } from "../lib/cn";

/**
 * Reusable typeahead-style picker.
 *
 * The defining feature: **the suggestion popup stays hidden until the
 * user actually types**. Eagerly rendering "here are 50 random rows"
 * the moment the field focuses adds noise without value — operators
 * always have at least a fragment of the name / id / reference they're
 * looking for. This component is generic so feature areas can build
 * thin wrappers (CustomerPicker, LoanPicker, AccountPicker, …)
 * without re-implementing the dropdown, keyboard handling, or
 * click-outside dance every time.
 *
 * Render-prop shape so callers retain full control over the per-row
 * markup:
 *
 *   <SearchInput
 *     items={customers}
 *     value={selectedCustomer}
 *     onSelect={(c) => setCustomer(c)}
 *     matches={(c, q) => c.firstName.includes(q)}
 *     getDisplayLabel={(c) => `${c.firstName} ${c.lastName}`}
 *     getItemKey={(c) => c.id}
 *     renderSuggestion={(c) => <div>...</div>}
 *     placeholder="Search by name..."
 *   />
 *
 * Behaviour summary:
 *   • idle  → just the input with search/chevron icons
 *             (or the first `maxResults` items, with `suggestOnFocus`)
 *   • typing → floating dropdown over content below
 *   • selected → input shows the chosen item's display label
 *   • clear (×) → drops selection, focuses input
 *   • keyboard → ↑/↓ moves highlight, Enter picks, Esc closes
 *   • mouse → click-outside closes the popup
 *
 * The popup is `absolute`-positioned so siblings beneath the field
 * don't shift around when results appear.
 */
export interface SearchInputProps<T> {
  /** Pool to search against. Render-prop functions destructure each item. */
  items: T[];
  /** Currently selected item, or null. Controlled. */
  value: T | null;
  /** Called when the user picks a row, or clears with the × button. */
  onSelect: (item: T | null) => void;
  /**
   * Substring match predicate. Receives the lower-cased trimmed query so
   * callers don't have to normalise every call. Return true to keep.
   */
  matches: (item: T, query: string) => boolean;
  /** What renders inside the input once an item is selected. */
  getDisplayLabel: (item: T) => string;
  /** Unique React key per row. */
  getItemKey: (item: T) => string;
  /** Custom row markup inside the popup. Receives the active flag for styling. */
  renderSuggestion: (
    item: T,
    ctx: { isActive: boolean; isSelected: boolean },
  ) => ReactNode;

  /** Placeholder when nothing is selected and the field is empty. */
  placeholder?: string;
  /** Max number of suggestions shown — typeahead encourages narrowing. */
  maxResults?: number;
  /**
   * Open the popup with the first `maxResults` items as soon as the field
   * is focused, before anything is typed. Off by default (the component's
   * usual stance is "no noise until you type"), but worth enabling where
   * the pool is small enough that seeing a starting set beats guessing at
   * a spelling — e.g. the customer pickers.
   */
  suggestOnFocus?: boolean;
  /** Optional wrapping className. */
  className?: string;
  /** Optional className applied to the input element. */
  inputClassName?: string;
  /** Disable the field. */
  disabled?: boolean;
  /**
   * Override the "no matches" hint text. Receives the (trimmed) query so
   * callers can phrase it naturally — `No members match "Maria"`.
   */
  emptyMessage?: (query: string) => ReactNode;
  /**
   * Optional aria-label for the input. If omitted we fall back to the
   * placeholder so screen readers always announce something.
   */
  ariaLabel?: string;
}

export function SearchInput<T>({
  items,
  value,
  onSelect,
  matches,
  getDisplayLabel,
  getItemKey,
  renderSuggestion,
  placeholder = "Search…",
  maxResults = 8,
  suggestOnFocus = false,
  className,
  inputClassName,
  disabled = false,
  emptyMessage,
  ariaLabel,
}: SearchInputProps<T>) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  // Hide suggestions when there's nothing to filter on — the point of
  // this component. The filter runs against the trimmed lowercased query.
  // With `suggestOnFocus` the empty query instead yields a starting set of
  // the first `maxResults` items rather than nothing.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return suggestOnFocus ? items.slice(0, maxResults) : [];
    const out: T[] = [];
    for (const item of items) {
      if (matches(item, q)) {
        out.push(item);
        if (out.length >= maxResults) break;
      }
    }
    return out;
  }, [items, query, matches, maxResults, suggestOnFocus]);

  // Reset highlight whenever results change so we don't index past end.
  useEffect(() => {
    setActiveIndex(0);
  }, [filtered.length]);

  // Click-outside closes the popup.
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const listboxId = useId();
  const showSuggestions = open && filtered.length > 0;

  const inputRef = useRef<HTMLInputElement>(null);

  const choose = (item: T) => {
    onSelect(item);
    setQuery("");
    setOpen(false);
  };

  const clear = () => {
    onSelect(null);
    setQuery("");
    setOpen(true);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!showSuggestions) {
      // Allow ArrowDown to re-open the dropdown if there's already a
      // query — useful when tabbing back into a field whose popup
      // closed on a previous interaction.
      if (e.key === "ArrowDown" && (suggestOnFocus || query.trim().length > 0))
        setOpen(true);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = filtered[activeIndex];
      if (pick) choose(pick);
    }
  };

  const displayValue = query || (value ? getDisplayLabel(value) : "");

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-fg-subtle" />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={showSuggestions}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-label={ariaLabel ?? placeholder}
          placeholder={placeholder}
          value={displayValue}
          disabled={disabled}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            // Typing past a locked-in selection signals the user wants to
            // change it — drop the FK so the form shows the search-in-
            // progress state instead of two competing values.
            if (value) onSelect(null);
          }}
          onFocus={() => {
            if (suggestOnFocus || query.trim().length > 0) setOpen(true);
          }}
          onKeyDown={onKeyDown}
          className={cn(
            "w-full rounded-md border bg-surface-2 pl-8 pr-8 py-2 text-sm",
            "border-default placeholder:text-fg-subtle",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "disabled:cursor-not-allowed disabled:opacity-60",
            value && "border-primary/40 bg-primary-soft text-fg",
            inputClassName,
          )}
        />
        {(value || query) && !disabled && (
          <button
            type="button"
            aria-label="Clear selection"
            onClick={clear}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-subtle hover:text-fg p-1 rounded-md"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
        {!value && !query && (
          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-fg-subtle" />
        )}
      </div>

      {/* Floating suggestion popup — only renders after a non-empty query. */}
      {showSuggestions && (
        <div
          id={listboxId}
          role="listbox"
          className={cn(
            "absolute z-30 left-0 right-0 mt-1 max-h-60 overflow-y-auto rounded-md border shadow-xl",
            "field-chrome",
          )}
        >
          {filtered.map((item, i) => {
            const isActive = i === activeIndex;
            const isSelected =
              value !== null && getItemKey(value) === getItemKey(item);
            return (
              <button
                key={getItemKey(item)}
                type="button"
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => choose(item)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors",
                  isActive ? "bg-surface-2" : "hover:bg-surface-2/60",
                )}
              >
                {/* Compact check column reserved so highlighted/selected
                    rows don't jump when the icon appears. */}
                <span className="w-3.5 shrink-0">
                  {isSelected && <Check className="h-3.5 w-3.5 text-primary" />}
                </span>
                <span className="flex-1 min-w-0">
                  {renderSuggestion(item, { isActive, isSelected })}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* "No match" hint — renders in the same floating slot so the layout
          below stays anchored regardless of result count. */}
      {open && query.trim().length > 0 && filtered.length === 0 && (
        <div
          className={cn(
            "absolute z-30 left-0 right-0 mt-1 rounded-md border shadow-xl",
            "border-default bg-surface-3 overlay-elevated px-3 py-2 text-xs text-fg-muted",
          )}
        >
          {emptyMessage
            ? emptyMessage(query.trim())
            : `No matches for “${query.trim()}”.`}
        </div>
      )}
    </div>
  );
}
