// Data surface for the pre-assessment feature. Re-exported from
// @loan/api-client so the pages import from one place and derivations can
// be injected here later without leaking outward.
export {
  usePreAssessment,
  usePreAssessments,
  useRunPreAssessment,
  type PreAssessmentFilter,
} from "@loan/api-client";
export { useCustomers, useLoanProducts } from "@loan/api-client";
