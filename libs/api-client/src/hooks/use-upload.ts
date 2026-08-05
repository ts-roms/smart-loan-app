import type { UploadResult } from "@loan/shared-types";
import { useMutation, useQuery } from "@tanstack/react-query";

import { getApiClient } from "../client";

export type UploadSubdir =
  "kyc" | "selfies" | "collateral" | "misc" | "signatures" | "branding";

/**
 * Multipart file upload. The server returns a stable `url` (under
 * `/uploads/...`) the caller stores wherever it makes sense — KYC submission,
 * application selfie, collateral photo, etc.
 */
export function useUpload() {
  return useMutation({
    mutationFn: async (input: { file: File; subdir: UploadSubdir }) => {
      const client = getApiClient();
      const fd = new FormData();
      fd.append("file", input.file);
      return client.request<UploadResult>(`/uploads-api/${input.subdir}`, {
        method: "POST",
        body: fd,
      });
    },
  });
}

export interface SignedUploadUrl {
  url: string;
  /** Null for public subdirs (branding), which need no signature. */
  expiresAt: number | null;
}

/**
 * Exchange a stored `/uploads/...` path for one the browser can load.
 *
 * Protected uploads (KYC documents, selfies, collateral, signatures)
 * require a short-lived signature. `<img src>` can't carry the Bearer
 * token, so the signature rides in the query string and is minted here
 * — see apps/api/src/features/uploads/signing.ts.
 *
 * Refetches at 80% of the URL's lifetime so an open review screen
 * doesn't decay into broken images while someone reads it. Cached per
 * path, so a list of thumbnails costs one request per distinct file
 * rather than one per component.
 *
 * Returns `undefined` while loading and for an empty input — callers
 * render their own placeholder rather than briefly requesting a
 * signature-less URL that would 403.
 */
export function useSignedUploadUrl(path: string | null | undefined) {
  const query = useQuery({
    queryKey: ["uploads", "signed", path],
    enabled: Boolean(path),
    queryFn: () =>
      getApiClient().request<SignedUploadUrl>("/uploads-api/sign", {
        method: "POST",
        body: JSON.stringify({ url: path }),
      }),
    // A signature is only as fresh as its expiry; don't serve a stale
    // one from cache on remount.
    staleTime: 0,
    refetchInterval: (q) => {
      const expiresAt = q.state.data?.expiresAt;
      if (!expiresAt) return false;
      return Math.max(30_000, (expiresAt - Date.now()) * 0.8);
    },
  });
  return query.data?.url;
}
