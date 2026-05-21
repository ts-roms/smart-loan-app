// CustomerPicker has been promoted to a feature-agnostic location at
// apps/web/src/components/CustomerPicker.tsx so other features (dorsi,
// ...) can use it without reaching into the cooperative folder. This
// file re-exports the canonical version for back-compat with the
// in-feature import path; new callers should import from
// '../../../components/CustomerPicker' (or a future barrel).
export { CustomerPicker } from "../../../components/CustomerPicker";
