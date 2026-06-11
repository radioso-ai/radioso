// Sanctioned adapter barrel (dependency-cruiser: engine-concretes-only-via-composition).
// Chat-internal clarification code consumes conversation-engine/-defaults concretes
// through this composition file so domain/service files depend only on the contract.
export {
  clarificationStage,
  decideClarification,
  resolvePendingClarification as resolveEnginePendingClarification,
} from "@radioso/conversation-engine";
export { conversationRoutineActivatorFromCandidate } from "@radioso/conversation-defaults";
