import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { ModelCallUsageContext } from "../../../shared/domain/modelCallUsageContext.js";
import type {
  JsonSchemaResponseFormat,
  ReasoningEffort,
  ReusableInputBoundary,
  TextGenerationStopReason,
} from "../../../shared/infra/llm/providerTypes.js";
import type { LlmCapabilityResolveInput } from "../../../shared/infra/llm/workspaceContext.js";

export type ChatGatewayUsageContext = ModelCallUsageContext;

export interface ChatGatewayGenerationOptions {
  maxOutputTokens?: number;
  reasoningEffort?: ReasoningEffort;
  responseFormat?: JsonSchemaResponseFormat;
}

/**
 * For a caller that reports how a completion ended. Only `answer` fills it: every call that
 * returns a completion overwrites `stopReason` with that completion's, which is undefined
 * when the provider gives none. `streamAnswer` ignores it.
 */
export interface ChatGatewayCompletionRecord {
  stopReason?: TextGenerationStopReason;
}

export interface ChatGatewayInput {
  query: string;
  history: MessageRecord[];
  prompt: string;
  systemPrompt?: string;
  reusableInputBoundary?: ReusableInputBoundary;
  /**
   * When set, the gateway resolves the chat model for this workspace
   * (with optional agent-level override) before delegating. When omitted,
   * the gateway uses the env-default chat client.
   */
  workspaceContext?: LlmCapabilityResolveInput;
  usageContext: ChatGatewayUsageContext;
  generation?: ChatGatewayGenerationOptions;
  signal?: AbortSignal;
  completionRecord?: ChatGatewayCompletionRecord;
}

export interface ChatGateway {
  answer(input: ChatGatewayInput): Promise<string>;
  streamAnswer(input: ChatGatewayInput): AsyncIterable<string>;
}
