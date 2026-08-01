/**
 * Directive→skill binding resolution is portable policy and lives in
 * `@radioso/conversation-defaults`. This module stays as the backend's import path
 * for it; the skill-state facts it consumes are still supplied by the host.
 */
export {
  resolveDirectiveBinding,
  type DirectiveBindingOutcome,
  type DirectiveBindingResolution,
  type DirectiveBindingSkillState,
  type DirectiveBindingSkipReason,
  type ResolveDirectiveBindingInput,
  type SkippedDirectiveBinding,
} from "@radioso/conversation-defaults";
