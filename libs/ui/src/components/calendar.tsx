/**
 * Shadcn-style `Calendar` — single-date picker built on react-day-picker v9.
 *
 * Styling matches the rest of the dark theme: muted weekday headers,
 * sky-tinted selected day, hover/focus rings, and clear month-navigation
 * arrows. Today is outlined; days outside the visible month dim.
 *
 * Usage:
 *   <Calendar mode="single" selected={date} onSelect={setDate} />
 *
 * For the most common case (a date input replacement) use `DatePicker`
 * from datepicker.tsx — it wraps this Calendar in a Popover + trigger.
 */

import { ChevronLeft, ChevronRight } from "lucide-react";
import { DayPicker } from "react-day-picker";
import "react-day-picker/style.css";
import { cn } from "../lib/cn";

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

export function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn("p-3", className)}
      classNames={{
        // Layout
        months: "flex flex-col sm:flex-row gap-4",
        month: "space-y-3",
        month_caption:
          "flex justify-center pt-1 relative items-center text-sm font-medium",
        caption_label: "text-sm font-medium",
        // Top nav arrows
        nav: "flex items-center gap-1",
        button_previous: cn(
          "absolute left-1 top-1 inline-flex h-7 w-7 items-center justify-center rounded-md border border-default bg-surface-2 hover:bg-hover text-fg hover:text-fg transition",
        ),
        button_next: cn(
          "absolute right-1 top-1 inline-flex h-7 w-7 items-center justify-center rounded-md border border-default bg-surface-2 hover:bg-hover text-fg hover:text-fg transition",
        ),
        // Weekday headings + day cells
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday:
          "w-9 text-[10px] uppercase tracking-wider text-fg-subtle font-normal",
        week: "flex w-full mt-1",
        day: "h-9 w-9 text-center text-sm p-0 relative",
        day_button: cn(
          "h-9 w-9 inline-flex items-center justify-center rounded-md font-normal text-fg",
          "hover:bg-hover hover:text-fg",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "aria-selected:opacity-100",
        ),
        selected:
          "[&_button]:bg-info [&_button]:text-white [&_button]:hover:bg-info [&_button]:hover:text-white",
        today: "[&_button]:border [&_button]:border-info/60 [&_button]:text-fg",
        outside: "[&_button]:text-fg-subtle",
        disabled: "[&_button]:text-fg-subtle [&_button]:cursor-not-allowed",
        hidden: "invisible",
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation }) =>
          orientation === "left" ? (
            <ChevronLeft className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          ),
      }}
      {...props}
    />
  );
}
