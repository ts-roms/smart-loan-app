/**
 * Right-side `Drawer` — built on the same Radix Dialog primitive as our
 * modal Dialog, but the Content slides in from the right edge and the
 * overlay sits beneath without blocking the page beneath.
 *
 * Use cases:
 *   - Detail / inspector views without losing list context
 *   - Quick previews triggered from a row click
 *   - Side-panel forms that would feel too heavy as a centered modal
 *
 * The trigger/content/header/footer slots mirror our Dialog so callers
 * who know the Dialog API are immediately productive here.
 */

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../lib/cn";

export const Drawer = DialogPrimitive.Root;
export const DrawerTrigger = DialogPrimitive.Trigger;
export const DrawerClose = DialogPrimitive.Close;

const DrawerOverlay = forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/40 backdrop-blur-sm",
      "data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out",
      className,
    )}
    {...props}
  />
));
DrawerOverlay.displayName = "DrawerOverlay";

export const DrawerContent = forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DrawerOverlay />
    <DialogPrimitive.Content
      ref={ref}
      onInteractOutside={(e) => {
        // Allow click-outside to close (more useful than the centered
        // dialog where we trap to prevent accidental dismissal).
        void e;
      }}
      className={cn(
        "fixed right-0 top-0 z-50 h-full w-full max-w-md border-l border-default bg-slate-950/95 backdrop-blur-xl shadow-2xl flex flex-col",
        "data-[state=open]:animate-drawer-in-right data-[state=closed]:animate-drawer-out-right",
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close
        className="absolute right-3 top-3 rounded-md p-1 text-fg-muted hover:text-fg hover:bg-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60"
        aria-label="Close drawer"
      >
        <X className="h-4 w-4" />
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
DrawerContent.displayName = "DrawerContent";

export const DrawerHeader = ({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "shrink-0 border-b border-default px-5 py-4 pr-12",
      "flex flex-col gap-1",
      className,
    )}
    {...props}
  />
);

export const DrawerBody = ({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex-1 overflow-y-auto px-5 py-4 space-y-4", className)}
    {...props}
  />
);

export const DrawerFooter = ({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "shrink-0 border-t border-default px-5 py-3 flex items-center justify-end gap-2",
      className,
    )}
    {...props}
  />
);

export const DrawerTitle = forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight",
      className,
    )}
    {...props}
  />
));
DrawerTitle.displayName = "DrawerTitle";

export const DrawerDescription = forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-xs text-fg-muted", className)}
    {...props}
  />
));
DrawerDescription.displayName = "DrawerDescription";
