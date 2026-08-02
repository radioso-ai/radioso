/**
 * The kit's runtime-agnostic core. It reaches no `node:*` builtin and no provider SDK,
 * so it runs anywhere ES modules do. The HTTP host lives at
 * `@radioso/conversation-kit/server`, the filesystem authoring store at
 * `@radioso/conversation-kit/node`.
 */
export {
  createConversationKit,
  type ConversationKit,
  type CreateConversationKitOptions,
  type RunConversationTurnInput,
} from "./composition.js";
export {
  RoutineRegistry,
  type RoutineRegistration,
} from "@radioso/conversation-defaults";
export {
  createConversationKitClient,
  type ConversationKitClient,
  type ConversationKitSession,
  type CreateConversationKitClientOptions,
  type CreateAgentInput,
  type CreateSessionInput,
  type SendMessageInput,
} from "./sdk.js";
export {
  TransientConversationKitAuthoringStore,
  type ConversationKitAuthoringStore,
  type UpdateConversationKitAgentInput,
  type UpdateConversationKitDirectiveInput,
  type UpdateConversationKitRoutineInput,
} from "./authoringStore.js";
export {
  createConversationKitModelGateway,
  type ConversationKitModelGatewayOptions,
} from "./modelGateway.js";
export {
  createDirectiveCoherenceChecker,
  createDirectiveCoherenceGate,
  DEFAULT_DIRECTIVE_COHERENCE_PROMPT,
  DirectiveCoherenceError,
  ModelDirectiveCoherenceChecker,
  type CreateDirectiveCoherenceCheckerOptions,
} from "@radioso/conversation-defaults";
export type {
  DirectiveCoherenceCheckInput,
  DirectiveCoherenceChecker,
  DirectiveCoherenceConflict,
  DirectiveCoherenceGate,
  DirectiveCoherenceGateOptions,
  DirectiveCoherenceMode,
  DirectiveCoherenceVerdict,
} from "@radioso/conversation-contract";
export {
  createDefaultConversationDirectiveMatcher,
  createDefaultConversationSkillDispatcher,
  createDefaultConversationSkillSelector,
  createDefaultRoutineSkillDispatcher,
  createModelBackedConversationComposer,
  type DefaultConversationSkillSelectorOptions,
  type LocalSkillHandler,
  type LocalSkillHandlerInput,
  type LocalSkillRegistry,
} from "./defaultPorts.js";
