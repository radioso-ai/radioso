/**
 * Public entry point for the context-variables module. Other modules (chat, routines) must
 * import from here, never from internal files, per the module-boundary lint.
 */
export { renderContextBlockWithBound } from "./contextBlockRenderer.js";
export { resolveAvailableContextVariables } from "./availableContextVariables.js";
export type { AvailableContextVariable } from "./availableContextVariables.js";
export { boundContextVariableFragments } from "./contextVariablesBound.js";
export type { ContextVariableRenderBoundConfig } from "./contextVariablesBound.js";
export { resolveContextForTurn, skillContextSnapshot } from "./contextResolutionService.js";
export { routineContextRenderer } from "./routineContextRenderer.js";
export { projectVisitorRequestFacts } from "./visitorRequestFacts.js";
export type { VisitorRequestFacts } from "./visitorRequestFacts.js";
export { projectContextForMatching } from "./matchContextProjection.js";
export type { MatchContextProjection } from "./matchContextProjection.js";
export {
  deriveVisitorIdentitySigningKey,
  signVisitorIdentity,
  verifySignedIdentity,
  verifySignedIdentityOutcome,
} from "./identitySigning.js";
export type { SignedIdentityOutcome, SignedVisitorIdentityPayload } from "./identitySigning.js";
export { ContextVariableResolverService } from "./contextVariableResolverService.js";
export type {
  ResolvedTurnContext,
  ResolvedVariableInput,
  ContextVariableSurfacing,
} from "./contextResolutionService.js";
export type { ContextResolverPort } from "./contextVariableResolverService.js";
export { BUILT_IN_CONTEXT_VARIABLES } from "./registry.js";
export {
  CONTEXT_VALUE_WRITER_KINDS,
  CONTEXT_VARIABLE_SCOPE_TYPES,
  CONTEXT_VARIABLE_SOURCES,
  CONTEXT_VARIABLE_VALUE_TYPES,
  classificationRefusal,
  contextScopeLadder,
  CONVERSATION_SCOPE_TYPES,
  frozenTestValueInput,
  isClassifiedEnablement,
  mayOverwrite,
  readsStoredValue,
  resolvedVariableInput,
  typeChangeWithValuesRefused,
} from "./domain.js";
export {
  CONTEXT_VARIABLE_OPTION_KEY_PATTERN,
  contextVariableOptionInputSchema,
  contextVariableOptionSchema,
  normalizeContextVariableOption,
} from "./optionSchema.js";
export { keepsEveryOptionKey, validateValue } from "./valueValidation.js";
export { contextValueChanged, contextValueChangedEvent } from "./contextValueChangedEvent.js";
export {
  ConversationValueWriterService,
  planConversationWrite,
} from "./conversationValueWriter.js";
export type {
  ConversationValueWriteOutcome,
  ConversationValueWriter,
  StoredConversationValue,
} from "./conversationValueWriter.js";
export { ATTRIBUTE_FILTER_NOT_SET, ConversationAttributeService } from "./conversationAttributes.js";
export type {
  ConversationAttribute,
  ConversationAttributeFilter,
  ConversationAttributeFilterInput,
  ConversationAttributeReadPort,
  ConversationAttributeReader,
  StoredConversationAttributeValue,
} from "./conversationAttributes.js";
export { ConversationAttributeEditService } from "./conversationAttributeEdits.js";
export type {
  AttributeEditActor,
  AttributeEditAudit,
  ConversationAttributeEditReads,
  ConversationAttributeEdits,
  ConversationReclassification,
} from "./conversationAttributeEdits.js";
export { classificationTargetFrom } from "./classifiedVariables.js";
export type { ClassificationTarget, ClassifiedVariableReader } from "./classifiedVariables.js";
export type {
  AgentContextVariableEnablement,
  ClassificationFitRefusal,
  ContextScopeKeys,
  ConversationScopeKeys,
  ConversationScope,
  ContextValueWriter,
  ContextValueWriterKind,
  ContextVariable,
  ContextVariableOption,
  ContextVariableScope,
  ContextVariableSensitivity,
  ContextVariableSource,
  ContextVariableTrustTier,
  ContextVariableValue,
  ContextVariableValueType,
} from "./domain.js";
export type {
  AgentContextVariableEnablementRecord,
  ApplyContextVariableProposalInput,
  ApplyContextVariableProposalOptions,
  ApplyContextVariableProposalResult,
  ContextVariableCreateRecord,
  ContextVariableEnablementReaderPort,
  ContextVariableRepositoryPort,
  ContextVariableResolutionReaderPort,
  ContextVariableUpdateRecord,
} from "./repository.js";
export { ContextVariableService } from "./services/contextVariableService.js";
export { freezeTestValues } from "./testValues.js";
export type {
  ContextVariableTestValueCatalogPort,
  ContextVariableTestValueSelection,
  FrozenTestValue,
  TestValue,
} from "./testValues.js";
export * from "./copilotPrimitiveRegistry.js";
