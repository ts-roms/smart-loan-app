import { useMyPermissions } from "@loan/api-client";

/**
 * Does the signed-in user hold this permission?
 *
 * Same source the API gates on (/auth/me/permissions → the RBAC tables),
 * so UI that hides itself and routes that refuse agree rather than each
 * guessing from the four-value User.role enum.
 *
 * Returns FALSE while the permission list is still loading. That's the
 * safe direction for the two things this is used for — deciding whether
 * to render a control, and deciding whether to fire a request. An
 * optimistic default would flash admin-only UI at everyone on each page
 * load and fire requests that 403.
 *
 * The underlying query is shared and cached, so calling this in several
 * components costs one request.
 */
export function usePermission(key: string): boolean {
  const { data } = useMyPermissions();
  return data?.permissions?.includes(key) ?? false;
}
