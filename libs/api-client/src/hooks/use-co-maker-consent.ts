import type {
  CoMakerDocument,
  CoMakerInviteView,
  KycDocumentType,
} from "@loan/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getApiClient } from "../client";

/**
 * Co-maker consent — the anonymous half.
 *
 * These call `/public/co-maker/*`, which sits outside `/api/v1` and
 * takes no Authorization header: the invite token is the credential.
 * They use plain `fetch` rather than the shared client for exactly
 * that reason — the client attaches a bearer token and would send a
 * signed-in officer's identity along with a co-maker's answer.
 */

const PUBLIC_BASE = "/public/co-maker";

async function publicJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${PUBLIC_BASE}${path}`, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      issues?: Array<{ message?: string }>;
    };
    // The reason matters here — "expired" and "already answered" both
    // need different words on screen than a generic failure.
    throw new Error(
      body.issues?.[0]?.message ?? body.error ?? `HTTP ${res.status}`,
    );
  }
  return (await res.json()) as T;
}

export function useCoMakerInvite(token: string) {
  return useQuery({
    queryKey: ["co-maker", "invite", token],
    queryFn: () => publicJson<CoMakerInviteView>(`/${token}`),
    enabled: Boolean(token),
    retry: false,
  });
}

export function useCoMakerRespond(token: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      decision: "APPROVED" | "DECLINED";
      declineReason?: string;
    }) =>
      publicJson<{ ok: true }>(`/${token}/respond`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["co-maker", "invite", token] });
    },
  });
}

/** Upload a file, then record it against the co-maker. */
export function useCoMakerUpload(token: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      file: File;
      documentType: KycDocumentType;
    }) => {
      const fd = new FormData();
      fd.append("file", input.file);
      const { url } = await publicJson<{ url: string }>(`/${token}/upload`, {
        method: "POST",
        body: fd,
      });
      return publicJson<CoMakerDocument>(`/${token}/documents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          documentType: input.documentType,
          documentUrl: url,
        }),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["co-maker", "invite", token] });
    },
  });
}

/**
 * Officer side: mint (or replace) a co-maker's invite link.
 *
 * Returns the URL for the officer to send. Resending invalidates the
 * previous link and clears any previous answer.
 */
export function useInviteCoMaker() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (coMakerId: string) =>
      getApiClient().post<{ url: string; expiresAt: string }>(
        `/loans/co-makers/${coMakerId}/invite`,
        {},
      ),
    onSuccess: () => {
      // Matches useLoanCoMakers in use-servicing — a fresh invite
      // resets the row's status, so the panel has to re-read it.
      void qc.invalidateQueries({ queryKey: ["co-makers"] });
    },
  });
}
