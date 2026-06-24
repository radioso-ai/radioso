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
export type {
  ResolvedTurnContext,
  PageContextInput,
  ResolvedVariableInput,
  ContextVariableSurfacing,
} from "./contextResolutionService.js";
export { redactSnapshot, REDACTED_VALUE } from "./redaction.js";
export type { ContextVariableSnapshot, SnapshotEntry } from "./redaction.js";
