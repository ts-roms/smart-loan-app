/**
 * Trigger a browser download of an authenticated CSV endpoint.
 *
 * Why this exists: the portal endpoints require a Bearer token, but a
 * plain `<a href="...">` element can't attach headers. We `fetch()`
 * with the token, get a blob, then synthesize an anchor click to save.
 *
 * Shared by every "Download CSV" button on the borrower portal.
 */
export async function downloadAuthedCsv(
  url: string,
  filename: string,
): Promise<void> {
  // The auth token is stashed by the api-client setup at login time
  // (same key the BulkPayments page uses). Keep this in sync if you
  // ever rename the storage key.
  const token = localStorage.getItem("loan.auth.token");
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    throw new Error(`Server returned ${res.status}`);
  }
  const blob = await res.blob();
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  // If the server set Content-Disposition with a filename, the browser
  // will prefer that — our hint is just a fallback for when the
  // server didn't set the header (or set it without a filename).
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}
