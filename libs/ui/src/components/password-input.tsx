import { Eye, EyeOff } from "lucide-react";
import { forwardRef, useState, type InputHTMLAttributes } from "react";

import { cn } from "../lib/cn";
import { Input } from "./input";

export type PasswordInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type"
> & {
  /**
   * What the toggle calls the thing it reveals, e.g. "confirmation".
   *
   * Exists because a form with two password fields otherwise has two
   * buttons both announcing "Show password", and a screen-reader user
   * moving between them has no way to tell which field they're about
   * to unmask.
   */
  revealLabel?: string;
};

/**
 * Password field with a reveal toggle.
 *
 * Worth having because the alternative is people typing their password
 * into a visible field somewhere else to check it, or giving up and
 * resetting. Masking protects against someone reading over a shoulder;
 * it should be the user's call whether anyone is.
 *
 * Starts masked, always. Revealing is a deliberate act, and a field
 * that remembered the last choice would eventually surprise someone in
 * an open-plan branch.
 *
 * The toggle is a `button` rather than a checkbox or an icon with a
 * click handler: it's reachable by keyboard, it announces its state,
 * and `tabIndex={-1}` keeps it out of the tab order between the field
 * and the submit button — tabbing from password straight to "Sign in"
 * is the common path and shouldn't detour through an eye.
 */
export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ className, revealLabel = "password", ...props }, ref) => {
    const [visible, setVisible] = useState(false);
    return (
      <div className="relative">
        <Input
          ref={ref}
          type={visible ? "text" : "password"}
          className={cn("pr-10", className)}
          {...props}
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setVisible((v) => !v)}
          aria-label={`${visible ? "Hide" : "Show"} ${revealLabel}`}
          aria-pressed={visible}
          className="absolute right-0 top-0 flex h-10 w-10 items-center justify-center text-fg-subtle transition hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-r-md"
        >
          {visible ? (
            <EyeOff className="h-4 w-4" />
          ) : (
            <Eye className="h-4 w-4" />
          )}
        </button>
      </div>
    );
  },
);
PasswordInput.displayName = "PasswordInput";
