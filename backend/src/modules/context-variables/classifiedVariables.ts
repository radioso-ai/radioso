import type { StoredConversationValue } from "./conversationValueWriter.js";
import { mayOverwrite, type ContextVariable, type ContextVariableValue } from "./domain.js";

/** A variable an agent has the classifier fill, with what the conversation holds for it. */
export interface ClassificationTarget {
  readonly variable: ContextVariable;
  /** The conversation's own value and who wrote it; null when it holds none. */
  readonly stored: StoredConversationValue | null;
  /**
   * Whether a writer the classifier may not replace holds a value anywhere on the conversation's
   * ladder: the conversation, its session or customer, the agent or the workspace. The classifier
   * leaves such a variable alone, so a value the API or a teammate set at any scope stays the one
   * the conversation resolves.
   */
  readonly held: boolean;
}

/** The target for a variable from every value its conversation's ladder holds for it. */
export const classificationTargetFrom = (
  variable: ContextVariable,
  ladderValues: readonly Pick<ContextVariableValue, "scope" | "data" | "writtenBy">[],
): ClassificationTarget => {
  const own = ladderValues.find((value) => value.scope.type === "conversation");
  return {
    variable,
    stored: own ? { data: own.data, writtenBy: own.writtenBy } : null,
    held: ladderValues.some((value) => !mayOverwrite(value.writtenBy, "classifier")),
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
