/**
 * Public entry point for the context-variables module. Other modules (chat, routines) must
 * import from here, never from internal files, per the module-boundary lint.
 */
export { renderContextBlock } from "./contextBlockRenderer.js";
export type { ContextFragment, PageContextFragment } from "./contextBlockRenderer.js";
export {
  ContextResolutionService,
  resolveContextForTurn,
} from "./contextResolutionService.js";
export type { ResolvedTurnContext, PageContextInput } from "./contextResolutionService.js";
export { redactSnapshot } from "./redaction.js";
export type { ContextVariableSnapshot } from "./redaction.js";
