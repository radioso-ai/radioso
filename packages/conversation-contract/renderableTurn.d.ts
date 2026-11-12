// The turn a renderer hands back to the engine, the directive grades and the reply blocks it carries.

import type { ReplyBlock } from "./replyBlocks.js";

export interface RenderableTurn {
  answer: string;
  /** Sources the turn grounded on; carries `ConversationCitation[]` when present. */
  citations?: unknown[];
  suggestions?: unknown[];
  /** Structured parts of the reply a channel renders beside its text, such as picture cards. */
  blocks?: ReplyBlock[];
  metadata?: Record<string, unknown> & {
    directiveAdherence?: DirectiveAdherenceEntry[];
    /**
     * Directive names of the rules rendered into the answer prompt that the answer
     * returned no adherence grade for (#1575).
     */
    ungradedDirectives?: string[];
  };
  /**
   * Set when a coverage verdict sink yielded this turn before any answer text
   * was released (#1260): `answer` is empty, and the engine substitutes the
   * post-evidence routine's own result as the turn's outcome.
   */
  yielded?: true;
}

/**
 * A reply whose content is decided but not yet generated: nothing is generated until the
 * holder asks. `render()` generates it whole. `stream()`, when present, generates it as
 * text deltas, in order, and returns the finished turn `render()` would have produced. Ask
 * once, by one of the two. A reply that can only be generated whole has no `stream`.
 */
export interface PendingRenderableTurn {
  render(): Promise<RenderableTurn>;
  stream?(): AsyncGenerator<string, RenderableTurn>;
}

/** A grounded answer's self-reported result for one active directive steering rule. */
export interface DirectiveAdherenceEntry {
  directive: string;
  ruleId: string;
  /**
   * What the answer committed this rule requires of it, written before the answer
   * itself (#1575). Absent when it committed nothing for the rule.
   */
  commitment?: string;
  satisfied: boolean;
  /**
   * Whether the rule's own condition (an authored `when:` clause, or a
   * coverage verdict criteria, #1260) actually held this turn. `false` means
   * the rule rendered but never applied, so `satisfied` carries no meaning —
   * report it as not-applicable, never as a violation.
   */
  applicable: boolean;
  /** Short operator-facing rationale; never source-document content. */
  note: string;
}
