import type { UploadResult } from "@loan/shared-types";
import { useMutation } from "@tanstack/react-query";

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
