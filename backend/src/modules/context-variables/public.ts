/**
 * Public entry point for the context-variables module. Other modules (chat, routines) must
 * import from here, never from internal files, per the module-boundary lint.
 */
export { renderContextBlockWithBound } from "./contextBlockRenderer.js";
export { resolveAvailableContextVariables } from "./availableContextVariables.js";
export { boundContextVariableFragments } from "./contextVariablesBound.js";
export type { ContextVariableRenderBoundConfig } from "./contextVariablesBound.js";
export { resolveContextForTurn } from "./contextResolutionService.js";
export { projectContextForMatching } from "./matchContextProjection.js";
export type { MatchContextProjection } from "./matchContextProjection.js";
export {
  deriveVisitorIdentitySigningKey,
  signVisitorIdentity,
  verifySignedIdentity,
} from "./identitySigning.js";
export type { SignedVisitorIdentityPayload } from "./identitySigning.js";
export { ContextVariableResolverService } from "./contextVariableResolverService.js";
export type {
  ResolvedTurnContext,
  ResolvedVariableInput,
  ContextVariableSurfacing,
} from "./contextResolutionService.js";
export type { ContextResolverPort } from "./contextVariableResolverService.js";
export { BUILT_IN_CONTEXT_VARIABLES } from "./registry.js";
export type {
  AgentContextVariableEnablement,
  ContextVariable,
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
  ApplyContextVariableProposalResult,
  ContextVariableCreateRecord,
  ContextVariableEnablementReaderPort,
  ContextVariableRepositoryPort,
  ContextVariableResolutionReaderPort,
  ContextVariableUpdateRecord,
} from "./repository.js";
export { ContextVariableService } from "./services/contextVariableService.js";
export * from "./copilotPrimitiveRegistry.js";
