import type { StoredConversationValue } from "./conversationValueWriter.js";
import type { ContextVariable } from "./domain.js";

/** A variable an agent has the classifier fill, with the value the conversation holds for it. */
export interface ClassificationTarget {
  readonly variable: ContextVariable;
  /** The conversation's own value and who wrote it; null when it holds none. */
  readonly stored: StoredConversationValue | null;
}

/** The classifier's read side: what it may fill, and what is filled already. */
export interface ClassifiedVariableReader {
  /**
   * The enabled `classified` variables of the revision the conversation is pinned to, each with
   * the conversation's value. Null when the conversation is gone; no targets when its revision
   * classifies nothing or it is pinned to none.
   */
  readConversationTargets(input: { workspaceId: string; conversationId: string }): Promise<{ agentId: string; targets: ClassificationTarget[] } | null>;
  /** The workspace's definitions of these variables, for a caller that holds the values itself. */
  readDefinitions(input: { workspaceId: string; variableIds: readonly string[] }): Promise<ContextVariable[]>;
}
