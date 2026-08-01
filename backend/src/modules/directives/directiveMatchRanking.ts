/**
 * Directive rank primitives live in `@radioso/conversation-defaults` so every host
 * that embeds the conversation engine reads a match's priority and confidence the
 * same way. This module stays as the backend's import path for them.
 */
export {
  DEFAULT_DIRECTIVE_PRIORITY,
  directiveMatchConfidence,
  directiveMatchPriority,
} from "@radioso/conversation-defaults";
