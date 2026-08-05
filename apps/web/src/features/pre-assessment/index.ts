// pre-assessment feature — run the decisioning rules before an
// application exists, and keep the answer.
//
// The verdict panel is exported because the borrower portal renders the
// same saved assessment (with `tone="borrower"`, which drops the internal
// underwriting detail). Everything else stays private.
export { PreAssessmentsPage } from "./pages/PreAssessments";
export { PreAssessmentVerdict } from "./components/PreAssessmentVerdict";
