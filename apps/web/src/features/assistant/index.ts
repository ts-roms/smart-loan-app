/**
 * Public surface of the assistant feature.
 *
 * Other features (loans, customers, collections) compose AssistantPanel
 * with their own context-specific tasks. The hooks live in
 * @loan/api-client — re-exported here so callers don't have to know
 * the dual-package structure.
 */
export {
  AssistantPanel,
  type AssistantPanelProps,
  type AssistantTask,
} from "./AssistantPanel";
export {
  useAssistantPing,
  useExplainDecision,
  useDraftDemandLetter,
  useSummarizeAccount,
  type AssistantResponse,
  type AssistantPingResult,
} from "@loan/api-client";
