import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { LlmCapabilityResolveInput } from "../../../shared/infra/llm/workspaceContext.js";

export interface ChatGatewayUsageContext {
  accountId?: string | null;
  workspaceId: string;
  conversationId: string;
  messageId: string;
  surface: string;
  operation: string;
  attemptKey: string;
}

export interface ChatGatewayInput {
  query: string;
  history: MessageRecord[];
  prompt: string;
  systemPrompt?: string;
  /**
   * When set, the gateway resolves the chat model for this workspace
   * (with optional agent-level override) before delegating. When omitted,
   * the gateway uses the env-default chat client.
   */
  workspaceContext?: LlmCapabilityResolveInput;
  usageContext?: ChatGatewayUsageContext;
}

export interface ChatGateway {
  answer(input: ChatGatewayInput): Promise<string>;
  streamAnswer(input: ChatGatewayInput): AsyncIterable<string>;
}
