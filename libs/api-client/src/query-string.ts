/**
 * Query-string builder for the list endpoints.
 *
 * The rule these hooks all need: an absent filter and an empty filter
 * must produce the same URL. Serializing `q=""` or `status=undefined`
 * would make every cleared control a distinct cache key and a distinct
 * request, so blank values are dropped rather than sent.
 */
/**
 * Takes `object` rather than `Record<string, …>` on purpose: the filter
 * types are interfaces, and TypeScript doesn't give interfaces an
 * implicit index signature, so a `Record` parameter would reject every
 * caller. Values are stringified defensively for the same reason.
 */
export function toQueryString(filter: object = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}
