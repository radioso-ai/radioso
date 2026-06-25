/**
 * Public entry point for the context-variables module. Other modules (chat, routines) must
 * import from here, never from internal files, per the module-boundary lint.
 */
export { renderContextBlock } from "./contextBlockRenderer.js";
export type {
  ContextFragment,
  PageContextFragment,
  VariableContextFragment,
} from "./contextBlockRenderer.js";
export {
  ContextResolutionService,
  resolveContextForTurn,
} from "./contextResolutionService.js";
export {
  deriveVisitorIdentitySigningKey,
  signVisitorIdentity,
  verifySignedIdentity,
} from "./identitySigning.js";
export type {
  SignedVisitorIdentityPayload,
  VerifiedVisitorIdentity,
  VerifySignedIdentityInput,
} from "./identitySigning.js";
export { ContextVariableResolverService } from "./contextVariableResolverService.js";
export type {
  ResolvedTurnContext,
  PageContextInput,
  ResolvedVariableInput,
  ContextVariableSurfacing,
} from "./contextResolutionService.js";
export type { ContextResolverPort } from "./contextVariableResolverService.js";
export { redactSnapshot, REDACTED_VALUE } from "./redaction.js";
export type { ContextVariableSnapshot, SnapshotEntry } from "./redaction.js";
export {
  BUILT_IN_CONTEXT_VARIABLES,
  BUILT_IN_CONTEXT_VARIABLE_BY_NAME,
} from "./registry.js";
export type { BuiltInContextVariableDescriptor } from "./registry.js";
export type {
  AgentContextVariableEnablement,
  ContextVariable,
  ContextVariableScope,
  ContextVariableScopeType,
  ContextVariableSensitivity,
  ContextVariableSource,
  ContextVariableTrustTier,
  ContextVariableValue,
  ContextVariableValueType,
} from "./domain.js";
