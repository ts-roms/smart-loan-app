/**
 * Loans feature data surface.
 *
 * Re-exports the loan-related hooks from `@loan/api-client` so callers
 * outside this feature don't need to know which file inside the api-client
 * package owns which hook. Also gives us a place to layer feature-specific
 * derivations (e.g. useLoanSummary that combines two queries) without
 * leaking those into the shared client.
 */
export {
  useLoans,
  useLoan,
  useQuote,
  useApplyLoan,
  useDecideLoan,
  useDisburseLoan,
  useRecordPayment,
  useCloseEarlyLoan,
  useRestructureLoan,
  useWriteOffLoan,
  useLoanKycStatus,
  useLoanProducts,
  useLoanNotes,
  useLoanPromises,
  useAddNote,
  useCreatePromise,
  useResolvePromise,
  useCreatePaymentIntent,
  usePaymentIntent,
  useMySignature,
  useSignAsOfficer,
  useSignAsBorrower,
  useActiveDelegations,
  useUpload,
} from '@loan/api-client';
