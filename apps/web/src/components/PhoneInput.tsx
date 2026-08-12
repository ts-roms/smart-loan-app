import {
  PHONE_MAX_DIGITS,
  normalizePhone,
  phoneError,
} from "@loan/shared-utils";
import { Input } from "@loan/ui";
import { useState } from "react";

/**
 * Phone number field.
 *
 * Digits only, enforced as you type rather than on submit — a field
 * that silently discards what you typed is confusing, but one that
 * accepts "0917-abc" and rejects it three fields later is worse. The
 * only characters that survive are the ones that end up stored.
 *
 * Punctuation people naturally type is allowed through and stripped:
 * "0917 123 4567" and "+63 917 123 4567" both normalise to
 * 09171234567, which is what the API stores and what search matches
 * against.
 *
 * The length error appears on blur, not on the first keystroke —
 * everyone's number is too short while they're still typing it.
 */
export function PhoneInput({
  value,
  onChange,
  required,
  disabled,
  placeholder = "09171234567",
  /** Blank is fine — for secondary numbers and other optional fields. */
  optional,
  /** Forwarded to the inner input so a `Field` label can name it. */
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  disabled?: boolean;
  placeholder?: string;
  optional?: boolean;
  id?: string;
}) {
  const [touched, setTouched] = useState(false);

  // Keep the raw digits: normalising to a display format mid-typing
  // moves the caret and makes backspace behave strangely.
  const handle = (raw: string) => {
    const digits = raw.replace(/[^\d+]/g, "");
    // +63 is worth accepting as an entry form; it's resolved on blur.
    onChange(digits.slice(0, PHONE_MAX_DIGITS + 3));
  };

  const error =
    touched && !(optional && value.trim() === "") ? phoneError(value) : null;

  return (
    <div className="space-y-1">
      <Input
        id={id}
        type="tel"
        inputMode="numeric"
        autoComplete="tel"
        value={value}
        onChange={(e) => handle(e.target.value)}
        onBlur={() => {
          setTouched(true);
          // Resolve +63 to a leading 0 once they've finished, so what
          // sits in the field is what gets stored.
          const normalized = normalizePhone(value);
          if (normalized && normalized !== value) onChange(normalized);
        }}
        placeholder={placeholder}
        required={required}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
      />
      {error && <p className="text-[10px] text-danger">{error}</p>}
    </div>
  );
}
