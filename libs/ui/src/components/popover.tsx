/**
 * Shadcn-style `Popover`. Generic floating panel — used by DatePicker
 * to anchor the Calendar to its trigger button. Same animation as
 * Dialog/Select for visual consistency.
 */

import * as PopoverPrimitive from "@radix-ui/react-popover";
import { forwardRef } from "react";
import { cn } from "../lib/cn";

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

export const PopoverContent = forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "center", sideOffset = 4, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "z-50 w-72 rounded-md border border-default bg-surface-3 backdrop-blur-xl p-3 text-fg shadow-2xl",
        // See select.tsx: opacity + scale-from-anchor only, never touch
        // translate (Radix owns the positioning transform).
        "origin-[var(--radix-popover-content-transform-origin)]",
        "data-[state=open]:animate-popover-in data-[state=closed]:animate-popover-out",
        className,
      )}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = "PopoverContent";
