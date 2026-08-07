import { downloadFile } from "@loan/api-client";

/**
 * Trigger a browser download of an authenticated CSV endpoint.
 *
 * Now a thin alias over `downloadFile`, kept because the portal's call
 * sites read better with a CSV-specific name. It used to hand-roll a
 * `fetch` reading `localStorage` directly — which worked until the
 * access token expired, then failed with "Server returned 401" on a
 * button that every other request on the page would have refreshed
 * through transparently.
 *
 * `url` is relative to the API base, not absolute.
 */
export async function downloadAuthedCsv(
  url: string,
  filename: string,
): Promise<void> {
  return downloadFile(url, filename);
}
