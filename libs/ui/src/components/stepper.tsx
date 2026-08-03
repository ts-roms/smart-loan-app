import { Check } from "lucide-react";
import { type ReactNode } from "react";

import { cn } from "../lib/cn";

export interface StepperStep {
  /** Stable id used by the parent to identify the step. */
  id: string;
  /** Short label rendered under the step indicator. */
  label: string;
  /** Optional secondary line (e.g. "optional", "skipped", "auto"). */
  hint?: string;
}

export interface StepperProps {
  steps: StepperStep[];
  /** Index of the step currently being edited. 0-based. */
  currentIndex: number;
  /**
   * Optional set of step ids that are "complete" (i.e. user has moved
   * past them). When omitted, indices < currentIndex are treated as
   * complete.
   */
  completedIds?: ReadonlySet<string>;
  /**
   * Called when the user clicks an already-visited step indicator. Lets
   * the parent let the user jump backwards through the wizard. Forward
   * jumps are intentionally not supported here — that's the parent's
   * "Next" button's job, gated on per-step validation.
   */
  onStepClick?: (index: number) => void;
  /** Optional trailing element (e.g. "Step 2 of 5" badge, "Save draft" button). */
  trailing?: ReactNode;
  className?: string;
}

/**
 * Horizontal stepper for multi-step forms. Each step has three states:
 *
 *   - `done`    — index < currentIndex (or id ∈ completedIds). Green
 *                 check icon, clickable to revisit.
 *   - `active`  — index === currentIndex. Sky highlight ring, current
 *                 label is full-opacity.
 *   - `upcoming`— index > currentIndex. Dim, not clickable.
 *
 * The connecting lines between indicators reflect the same state: solid
 * sky for done, dashed for upcoming. Layout collapses to vertical-only
 * on narrow viewports.
 */
export function Stepper({
  steps,
  currentIndex,
  completedIds,
  onStepClick,
  trailing,
  className,
}: StepperProps) {
  return (
    <div className={cn("flex items-center justify-between gap-3", className)}>
      <ol className="flex-1 flex items-center gap-1">
        {steps.map((step, i) => {
          const isActive = i === currentIndex;
          const isDone = completedIds
            ? completedIds.has(step.id)
            : i < currentIndex;
          const isUpcoming = !isActive && !isDone;
          const canClick = isDone && !!onStepClick;
          return (
            <li
              key={step.id}
              className={cn(
                "flex items-center flex-1 min-w-0",
                i === steps.length - 1 && "flex-initial",
              )}
            >
              <button
                type="button"
                disabled={!canClick}
                onClick={() => canClick && onStepClick(i)}
                aria-current={isActive ? "step" : undefined}
                className={cn(
                  "group flex items-center gap-2 min-w-0",
                  canClick ? "cursor-pointer" : "cursor-default",
                )}
              >
                <span
                  className={cn(
                    "inline-flex items-center justify-center h-7 w-7 rounded-full border text-xs font-semibold shrink-0 transition-colors",
                    isActive &&
                      "border-sky-400 bg-sky-500/15 text-info ring-2 ring-sky-400/30",
                    isDone &&
                      "border-emerald-400/40 bg-emerald-500/10 text-success group-hover:bg-emerald-500/20",
                    isUpcoming && "border-default bg-surface-2 text-fg-subtle",
                  )}
                >
                  {isDone ? <Check className="h-3.5 w-3.5" /> : i + 1}
                </span>
                <span className="flex flex-col items-start min-w-0 leading-tight">
                  <span
                    className={cn(
                      "text-xs font-medium truncate max-w-[12rem]",
                      isActive && "text-fg",
                      isDone && "text-fg group-hover:text-fg",
                      isUpcoming && "text-fg-subtle",
                    )}
                  >
                    {step.label}
                  </span>
                  {step.hint && (
                    <span
                      className={cn(
                        "text-[10px] truncate max-w-[12rem]",
                        isActive ? "text-info/80" : "text-fg-subtle",
                      )}
                    >
                      {step.hint}
                    </span>
                  )}
                </span>
              </button>
              {/* Connector line — only between steps, not after the last */}
              {i < steps.length - 1 && (
                <span
                  className={cn(
                    "flex-1 mx-2 h-px",
                    isDone ? "bg-emerald-400/40" : "bg-surface-3",
                  )}
                />
              )}
            </li>
          );
        })}
      </ol>
      {trailing && <div className="shrink-0">{trailing}</div>}
    </div>
  );
}
