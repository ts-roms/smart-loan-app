import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "../lib/cn";

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      ref={ref}
      className={cn(
        "field-chrome flex h-10 w-full rounded-md px-3 py-2 text-sm placeholder:text-fg-subtle",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";
