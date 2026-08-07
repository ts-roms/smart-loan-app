import { getApiClient } from "./client";

/**
 * Save an authenticated endpoint's response as a file.
 *
 * Goes through the ApiClient rather than a bare `fetch`, so a download
 * gets the same Bearer token and the same transparent refresh-on-401 as
 * every other request. The two call sites that hand-rolled this each
 * read `localStorage` directly: they worked until the access token
 * expired, then reported "Server returned 401" on a button the user had
 * just filled a date range into.
 *
 * `path` is relative to the API base — "/reports/ecl-movement?..." —
 * not an absolute URL, so the base and the tenant handling stay in one
 * place.
 */
export async function downloadFile(
  path: string,
  filename: string,
): Promise<void> {
  const blob = await getApiClient().fetchBlob(path);
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  /*
   * `download` names the file, full stop. The old comments here claimed
   * the server's Content-Disposition would win — it cannot: the
   * response has already been read into a Blob, and a blob: URL carries
   * no headers. Whatever is passed in IS the filename.
   */
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(href);
}
