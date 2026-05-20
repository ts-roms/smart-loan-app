import { getApiClient } from '@loan/api-client';

/**
 * Fetch a PDF endpoint (which lives behind bearer auth, so a plain anchor
 * won't work) and trigger a browser download. The returned promise resolves
 * once the file has been saved.
 *
 * Resolves `path` relative to the API base — pass the part after
 * `/api/v1`, e.g. `/loans/abc/agreement.pdf`.
 */
export async function downloadPdf(path: string, suggestedFilename: string): Promise<void> {
  const client = getApiClient();
  // Use `request` so the token + base URL are applied. We override the
  // JSON-decoding default by reaching into the underlying fetch.
  const baseUrl = (client as unknown as { opts: { baseUrl: string; getToken?: () => string | null | undefined } }).opts.baseUrl;
  const token = (client as unknown as { opts: { getToken?: () => string | null | undefined } }).opts.getToken?.();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, { headers });
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status}`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedFilename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
