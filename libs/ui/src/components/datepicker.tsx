/**
 * Drop-in replacement for `<input type="date" />`. Renders as a button that
 * shows the formatted date; clicking opens a Popover with the Calendar.
 *
 * API matches an HTML input as closely as possible:
 *   - `value`: ISO date string ("YYYY-MM-DD"), or "" for empty
 *   - `onChange(iso)`: called with the new ISO string (or "" if cleared)
 *   - `min` / `max`: ISO bounds, both inclusive
 *
 * Why ISO strings rather than Date? The callers all stash dates in form
 * state that ultimately serializes to JSON — using strings end-to-end
 * avoids a layer of conversion noise.
 */

import { format, parse } from "date-fns";
import { CalendarIcon, X } from "lucide-react";
import { useState } from "react";
import { Calendar } from "./calendar";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { cn } from "../lib/cn";

const ISO = "yyyy-MM-dd";

function isoToDate(iso: string | undefined): Date | undefined {
  if (!iso) return undefined;
  const d = parse(iso, ISO, new Date());
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function dateToIso(d: Date | undefined): string {
  return d ? format(d, ISO) : "";
}

export interface DatePickerProps {
  value: string;
  onChange: (iso: string) => void;
  /** Inclusive lower bound (ISO). */
  min?: string;
  /** Inclusive upper bound (ISO). */
  max?: string;
  placeholder?: string;
  disabled?: boolean;
  /** When true, show a small X button to clear the date. */
  clearable?: boolean;
  className?: string;
  /** Display format for the trigger label (date-fns format string). */
  displayFormat?: string;
}

export function DatePicker({
  value,
  onChange,
  min,
  max,
  placeholder = "Pick a date",
  disabled,
  clearable,
  className,
  displayFormat = "PP",
}: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const selected = isoToDate(value);
  const minDate = isoToDate(min);
  const maxDate = isoToDate(max);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "flex h-10 w-full items-center justify-between gap-2 rounded-md border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-left",
            "hover:bg-white/[0.06] focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60",
            "disabled:cursor-not-allowed disabled:opacity-50",
            selected ? "text-white" : "text-white/45",
            className,
          )}
        >
          <span className="truncate">
            {selected ? format(selected, displayFormat) : placeholder}
          </span>
          <span className="flex items-center gap-1">
            {clearable && selected && !disabled && (
              <span
                role="button"
                aria-label="Clear date"
                onPointerDown={(e) => {
                  // Stop the Popover trigger from opening when the user
                  // clicks the X — handle clear inline and bail.
                  e.preventDefault();
                  e.stopPropagation();
                  onChange("");
                }}
                className="rounded-sm p-0.5 text-white/55 hover:text-white hover:bg-white/[0.08]"
              >
                <X className="h-3 w-3" />
              </span>
            )}
            <CalendarIcon className="h-4 w-4 opacity-60" />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={selected}
          onSelect={(d) => {
            onChange(dateToIso(d));
            setOpen(false);
          }}
          defaultMonth={selected ?? maxDate ?? minDate}
          // react-day-picker's Matcher rejects an object with undefined
          // before/after, so build an array of only the active bounds.
          disabled={[
            ...(minDate ? [{ before: minDate }] : []),
            ...(maxDate ? [{ after: maxDate }] : []),
          ]}
          autoFocus
        />
      </PopoverContent>
    </Popover>
  );
}
