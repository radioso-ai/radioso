import type { ModelCallUsageContext } from "../../shared/domain/modelCallUsageContext.js";
import type { ModelInferencePipeline } from "../../shared/infra/llm/modelInferencePipeline.js";

/**
 * What the classifier reads of a conversation: its rolling summary when it has one, and the
 * visitor's latest messages, oldest first. A message of a turn whose routine held a sensitive slot
 * is never among them; `withheldCount` says how many of the latest were left out for that reason.
 */
export interface ConversationExcerpt {
  readonly summary: string | null;
  readonly messages: readonly string[];
  readonly withheldCount: number;
}

/** Implemented by chat, which owns conversations, messages and their summary. */
export interface ConversationExcerptReader {
  /** Null when the conversation is gone. */
  readExcerpt(input: {
    workspaceId: string;
    conversationId: string;
    maxMessages: number;
    maxMessageChars: number;
  }): Promise<ConversationExcerpt | null>;
}

/** A workspace's `rewrite`-tier model, with every call metered under the usage context it is given. */
export interface ClassificationInferenceFactory {
  create(input: {
    workspaceContext: { workspaceId: string };
    modelCallContext: ModelCallUsageContext;
  }): Promise<Pick<ModelInferencePipeline, "complete">>;
}
