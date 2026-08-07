import type {
  EraseCustomerResult,
  RetentionPolicyView,
  RetentionPurgeResult,
} from "@loan/shared-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getApiClient } from "../client";
import { downloadFile } from "../download";

/**
 * Data-privacy hooks — DSAR export / erasure and the retention policy.
 *
 * Everything here sits behind `admin.compliance`, a permission held
 * apart from `admin.users` on purpose: the operator who answers data
 * subject requests is not necessarily the one who manages accounts.
 */

export const complianceKeys = {
  retention: ["compliance", "retention-policy"] as const,
};

export function useRetentionPolicy() {
  return useQuery({
    queryKey: complianceKeys.retention,
    queryFn: () =>
      getApiClient().get<RetentionPolicyView>("/compliance/retention-policy"),
  });
}

export function useUpdateRetentionPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      auditRetentionDays: number;
      notificationRetentionDays: number;
      jobRunRetentionDays: number;
    }) =>
      getApiClient().request<RetentionPolicyView>(
        "/compliance/retention-policy",
        { method: "PUT", body: JSON.stringify(input) },
      ),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: complianceKeys.retention }),
  });
}

export function useRunRetentionPurge() {
  return useMutation({
    mutationFn: () =>
      getApiClient().post<RetentionPurgeResult>(
        "/compliance/retention-purge",
        {},
      ),
  });
}

/**
 * DSAR export — downloads the customer's complete data as a JSON file.
 *
 * A POST download, not a hook-shaped query: the body carries the audit
 * reason, and the server writes an audit row per export, so caching or
 * refetching it would mint phantom audit entries. The filename mirrors
 * the server's Content-Disposition shape (a blob: URL cannot read it).
 */
export async function downloadDsarExport(
  customerId: string,
  reason?: string,
): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await downloadFile(
    `/compliance/customers/${customerId}/export`,
    `dsar-${customerId}-${stamp}.json`,
    { method: "POST", body: JSON.stringify({ reason: reason || undefined }) },
  );
}

export function useEraseCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      customerId: string;
      reason: string;
      acknowledgesRetention: true;
    }) =>
      getApiClient().post<EraseCustomerResult>(
        `/compliance/customers/${input.customerId}/erase`,
        {
          reason: input.reason,
          acknowledgesRetention: input.acknowledgesRetention,
        },
      ),
    onSuccess: () => {
      // The customer's PII just changed everywhere it is displayed.
      void qc.invalidateQueries({ queryKey: ["customers"] });
    },
  });
}
