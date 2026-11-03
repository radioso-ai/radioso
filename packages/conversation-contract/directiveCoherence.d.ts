// The coherence check a directive goes through before it is saved: whether it conflicts with the agent's other directives.
import type { ConversationAgentConfig, Directive } from "./index.js";

export interface DirectiveCoherenceConflict {
  directiveId?: string;
  directiveName: string;
  reason: string;
}

export interface DirectiveCoherenceVerdict {
  coherent: boolean;
  conflicts: DirectiveCoherenceConflict[];
  rationale: string;
}

/**
 * The stable, structural shape of a rejection from a conversation-kit
 * directive-coherence check. Consumers identify it with the kit's
 * `isDirectiveCoherenceError` helper rather than a cross-package `instanceof`.
 */
export interface DirectiveCoherenceError {
  code: "conversation_kit_directive_coherence_conflict";
  verdict: DirectiveCoherenceVerdict;
}

export interface DirectiveCoherenceInvocationContext {
  workspaceId: string;
  agentId: string;
}

export interface DirectiveCoherenceCheckInput {
  agent: ConversationAgentConfig;
  candidate: Directive;
  existingDirectives: Directive[];
  invocationContext?: DirectiveCoherenceInvocationContext;
}

export interface DirectiveCoherenceChecker {
  check(input: DirectiveCoherenceCheckInput): Promise<DirectiveCoherenceVerdict>;
}

export type DirectiveCoherenceMode = "enforce";

export interface DirectiveCoherenceGateOptions {
  enabled?: boolean;
  mode?: DirectiveCoherenceMode;
  checker?: DirectiveCoherenceChecker;
  promptTemplate?: string;
}

export interface DirectiveCoherenceGate {
  mode: DirectiveCoherenceMode;
  checker: DirectiveCoherenceChecker;
}
