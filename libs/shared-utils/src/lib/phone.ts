/**
 * Philippine phone numbers.
 *
 * One definition, shared by the forms and the API, because a rule the
 * client enforces and the server doesn't is a suggestion — and the
 * reverse is a form that submits and then fails.
 *
 * ## What counts
 *
 * Ten or eleven digits, once punctuation and a country code are
 * stripped. That covers both shapes people actually write:
 *
 *   09171234567   mobile, 11 digits            (the common case)
 *   9171234567    mobile without the 0, 10
 *   0281234567    landline with area code, 10
 *
 * Stored normalised — digits only, leading 0 — so "+63 917 123 4567",
 * "0917-123-4567" and "09171234567" are one number rather than three.
 * Search and duplicate detection both depend on that.
 */

export const PHONE_MIN_DIGITS = 10;
export const PHONE_MAX_DIGITS = 11;

/**
 * Strip a number to digits, resolving the country code.
 *
 * `+63` and a bare leading `63` both become `0`: +639171234567 and
 * 09171234567 are the same phone, and storing them differently means
 * the second registration of one borrower looks like a new one.
 *
 * A leading `63` is only treated as a country code when what follows
 * is the right length to be a national number — otherwise a Cebu
 * landline starting 63 would lose its first two digits.
 */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("63") && digits.length === PHONE_MAX_DIGITS + 1) {
    return `0${digits.slice(2)}`;
  }
  return digits;
}

/** Is this a usable PH number? Empty is NOT valid — check optionality first. */
export function isValidPhone(raw: string): boolean {
  const digits = normalizePhone(raw);
  return digits.length >= PHONE_MIN_DIGITS && digits.length <= PHONE_MAX_DIGITS;
}

/**
 * Why a number was rejected, or null when it's fine.
 *
 * Returns the reason rather than a boolean so a form can say what's
 * wrong instead of just going red — "10 or 11 digits, you typed 9"
 * beats "invalid".
 */
export function phoneError(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return "Enter a phone number";
  const digits = normalizePhone(trimmed);
  if (digits.length === 0) return "Enter a phone number";
  if (digits.length < PHONE_MIN_DIGITS) {
    return `Too short — ${PHONE_MIN_DIGITS} or ${PHONE_MAX_DIGITS} digits, you have ${digits.length}`;
  }
  if (digits.length > PHONE_MAX_DIGITS) {
    return `Too long — ${PHONE_MIN_DIGITS} or ${PHONE_MAX_DIGITS} digits, you have ${digits.length}`;
  }
  return null;
}

/**
 * Display form: `0917 123 4567` for an 11-digit mobile, `02 8123 4567`
 * for a 10-digit landline. Anything else is returned as given —
 * legacy rows predate this rule and shouldn't be mangled on their way
 * to the screen.
 */
export function formatPhone(raw: string): string {
  const d = normalizePhone(raw);
  if (d.length === 11) return `${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7)}`;
  if (d.length === 10) return `${d.slice(0, 2)} ${d.slice(2, 6)} ${d.slice(6)}`;
  return raw;
}

/**
 * Should this write be rejected?
 *
 * Validation applies to a number that is being CHANGED, not to one
 * that merely rides along in the request body. Forms resubmit every
 * field they rendered, so a strict check on the value alone would let
 * one bad legacy number block every future edit of that record —
 * including the edit that fixes it, if the operator started with the
 * address.
 *
 * `previous` is what's on file. Passing it unchanged is always
 * allowed; changing it means meeting the rule.
 */
export function phoneChangeError(
  next: string,
  previous: string | null | undefined,
  { optional = false }: { optional?: boolean } = {},
): string | null {
  const incoming = normalizePhone(next);
  if (incoming === normalizePhone(previous ?? "")) return null;
  if (optional && incoming === "") return null;
  return phoneError(next);
}
