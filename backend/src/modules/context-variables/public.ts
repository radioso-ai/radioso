/**
 * Public entry point for the context-variables module. Other modules (chat, routines) must
 * import from here, never from internal files, per the module-boundary lint.
 */
export { renderContextBlock } from "./contextBlockRenderer.js";
export type { ContextFragment, PageContextFragment } from "./contextBlockRenderer.js";
