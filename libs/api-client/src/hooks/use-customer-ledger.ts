/**
 * Customer ledger hook + CSV-download helper.
 *
 * The ledger endpoint accepts an `idOrNumber` path param — callers can
 * pass either the customer UUID or the human "CUST-..." reference; the
 * server resolves the right one.
 */

import type { CustomerLedger, CustomerLedgerScope } from "@loan/shared-types";
import { useQuery } from "@tanstack/react-query";

import { getApiClient } from "../client.js";

export interface CustomerLedgerQuery {
  from?: string;
  to?: string;
  scope?: CustomerLedgerScope;
}

export const customerLedgerKeys = {
  forCustomer: (idOrNumber: string, q?: CustomerLedgerQuery) =>
    [
      "customer-ledger",
      idOrNumber,
      q?.from ?? "",
      q?.to ?? "",
      q?.scope ?? "ALL",
    ] as const,
};

function buildQuery(q: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v) params.set(k, v);
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

export function useCustomerLedger(
  idOrNumber: string | null,
  query?: CustomerLedgerQuery,
) {
  return useQuery({
    queryKey: customerLedgerKeys.forCustomer(idOrNumber ?? "", query),
    queryFn: () =>
      getApiClient().get<CustomerLedger>(
        `/customers/${idOrNumber}/ledger${buildQuery({
          from: query?.from,
          to: query?.to,
          scope: query?.scope,
        })}`,
      ),
    enabled: !!idOrNumber,
    // Short staleTime — payments + contributions land frequently and the
    // ledger should reflect them on the next render.
    staleTime: 10_000,
  });
}

/**
 * Borrower-facing variant — pulls the authenticated customer's own
 * ledger via the /portal namespace. Scope + range filters work the same
 * way as the staff endpoint.
 */
export function usePortalLedger(query?: CustomerLedgerQuery) {
  return useQuery({
    queryKey: [
      "portal-ledger",
      query?.from ?? "",
      query?.to ?? "",
      query?.scope ?? "ALL",
    ] as const,
    queryFn: () =>
      getApiClient().get<CustomerLedger>(
        `/portal/me/ledger${buildQuery({
          from: query?.from,
          to: query?.to,
          scope: query?.scope,
        })}`,
      ),
    staleTime: 10_000,
  });
}

/**
 * Trigger a CSV download of the customer's ledger. The api-client's
 * `request()` method always JSON-decodes, so for non-JSON endpoints
 * we reach through to its internal opts (baseUrl + token getter) to
 * issue a raw fetch and stream the file. Same pattern as the existing
 * downloadPdf helper.
 */
export async function downloadCustomerLedgerCsv(
  idOrNumber: string,
  query?: CustomerLedgerQuery,
): Promise<void> {
  const client = getApiClient();
  type ClientInternals = {
    opts: {
      baseUrl: string;
      getToken?: () => string | null | undefined;
    };
  };
  const internals = client as unknown as ClientInternals;
  const baseUrl = internals.opts.baseUrl;
  const token = internals.opts.getToken?.();

  const path = `/customers/${idOrNumber}/ledger${buildQuery({
    from: query?.from,
    to: query?.to,
    scope: query?.scope,
    format: "csv",
  })}`;
  const headers: Record<string, string> = { Accept: "text/csv" };
  if (token) headers.Authorization = `Bearer ${token}`;

  await downloadFromPath(
    `${baseUrl}${path}`,
    headers,
    `statement-${idOrNumber}.csv`,
  );
}

/** Borrower variant — same dance, hits /portal/me/ledger. */
export async function downloadPortalLedgerCsv(
  query?: CustomerLedgerQuery,
): Promise<void> {
  const client = getApiClient();
  type ClientInternals = {
    opts: { baseUrl: string; getToken?: () => string | null | undefined };
  };
  const internals = client as unknown as ClientInternals;
  const baseUrl = internals.opts.baseUrl;
  const token = internals.opts.getToken?.();
  const path = `/portal/me/ledger${buildQuery({
    from: query?.from,
    to: query?.to,
    scope: query?.scope,
    format: "csv",
  })}`;
  const headers: Record<string, string> = { Accept: "text/csv" };
  if (token) headers.Authorization = `Bearer ${token}`;
  await downloadFromPath(`${baseUrl}${path}`, headers, `my-statement.csv`);
}

/**
 * Trigger a "your statement is ready" notification to the customer.
 * The endpoint is fire-and-record: it queues IN_APP + EMAIL rows; we
 * just relay the server's confirmation back to the UI.
 */
export async function emailCustomerStatement(
  idOrNumber: string,
): Promise<{ ok: boolean; sentTo: string | null; message: string }> {
  return getApiClient().post<{
    ok: boolean;
    sentTo: string | null;
    message: string;
  }>(`/customers/${idOrNumber}/ledger/email`, {});
}

async function downloadFromPath(
  url: string,
  headers: Record<string, string>,
  filename: string,
): Promise<void> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Statement download failed (${res.status})`);
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so Safari has time to start the save dialog.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}
