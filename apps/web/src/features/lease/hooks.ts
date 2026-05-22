/**
 * Lease feature data-access surface. Re-exports the hooks from
 * `@loan/api-client` so the feature's components have one explicit
 * entry point. Keeps the option open to wrap a hook with feature-
 * specific derivations later without changing call sites.
 */
export {
  useLeases,
  useLease,
  useBuyoutLease,
  usePullOutLease,
  useReturnLease,
  useExtendLease,
  leaseKeys,
} from "@loan/api-client";
