import type { StoredConversationValue } from "./conversationValueWriter.js";
import { mayOverwrite, type ContextVariable, type ContextVariableScopeType, type ContextVariableValue } from "./domain.js";

/** A variable an agent has the classifier fill, with what the conversation holds for it. */
export interface ClassificationTarget {
  readonly variable: ContextVariable;
  /** The conversation's own value and who wrote it; null when it holds none. */
  readonly stored: StoredConversationValue | null;
  /**
   * Whether a writer the classifier may not replace set a value for this conversation, its session
   * or its customer. Such a value is a fact about the visitor or the conversation: the classifier
   * leaves the variable alone, so that value stays the one the conversation resolves. An agent-wide
   * or workspace-wide value is a default and never holds a variable.
   */
  readonly held: boolean;
}

/**
 * Whether a human-written value at this scope is a fact about the visitor or the conversation, which
 * the classifier must not hide, rather than a default its conversation value outranks.
 */
const DESCRIBES_THE_VISITOR: Record<ContextVariableScopeType, boolean> = {
  conversation: true,
  session: true,
  customer: true,
  agent: false,
  workspace: false,
};

/** The target for a variable from every value its conversation's ladder holds for it. */
export const classificationTargetFrom = (
  variable: ContextVariable,
  ladderValues: readonly Pick<ContextVariableValue, "scope" | "data" | "writtenBy">[],
): ClassificationTarget => {
  const own = ladderValues.find((value) => value.scope.type === "conversation");
  return {
    variable,
    stored: own ? { data: own.data, writtenBy: own.writtenBy } : null,
    held: ladderValues.some((value) => DESCRIBES_THE_VISITOR[value.scope.type] && !mayOverwrite(value.writtenBy, "classifier")),
  };
};

/** The classifier's read side: what it may fill, and what is filled already. */
export interface ClassifiedVariableReader {
  /**
   * The enabled `classified` variables of the revision the conversation is pinned to, each with
   * what the conversation's ladder holds for it. Null when the conversation is gone; no targets
   * when its revision classifies nothing or it is pinned to none.
   */
  readConversationTargets(input: { workspaceId: string; conversationId: string }): Promise<{ agentId: string; targets: ClassificationTarget[] } | null>;
  /** The workspace's definitions of these variables, for a caller that holds the values itself. */
  readDefinitions(input: { workspaceId: string; variableIds: readonly string[] }): Promise<ContextVariable[]>;
}
