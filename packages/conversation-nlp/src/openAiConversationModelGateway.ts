import OpenAI from "openai";

import type {
  ConversationMessage,
  ConversationModelGateway,
} from "@radioso/conversation-contract";

import { normalizeOpenAIUsage, withoutUndefined } from "./openAiMetadata.js";
import { toOpenAIChatMessages } from "./openAiMessages.js";
import type {
  OpenAIChatClient,
  OpenAIChatCompletionRequest,
  OpenAIChatCompletionResponse,
  OpenAIConversationModelGatewayOptions,
} from "./openAiTypes.js";

export class OpenAIConversationModelGateway implements ConversationModelGateway {
  private readonly client: OpenAIChatClient;
  private readonly model: string;
  private readonly reasoningEffort?: OpenAIConversationModelGatewayOptions["reasoningEffort"];
  private readonly supportsReasoningEffort: boolean;

  constructor(options: OpenAIConversationModelGatewayOptions) {
    this.client = options.client ?? (options.apiKey ? new OpenAI({ apiKey: options.apiKey }) : new OpenAI());
    this.model = options.model;
    this.reasoningEffort = options.reasoningEffort;
    this.supportsReasoningEffort = options.supportsReasoningEffort === true;
  }

  async complete(input: {
    messages: ConversationMessage[];
    systemPrompt?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ text: string; metadata?: Record<string, unknown> }> {
    const request: OpenAIChatCompletionRequest = {
      model: this.model,
      messages: toOpenAIChatMessages(input),
      ...(this.supportsReasoningEffort && this.reasoningEffort
        ? { reasoning_effort: this.reasoningEffort }
        : {}),
    };
    const response = await this.createCompletion(request);
    const choice = response.choices[0];
    if (!choice) {
      throw new Error("openai_chat_completion_missing_choice");
    }
    const text = choice.message?.content?.trim();
    if (!text) {
      throw completionTextError(choice);
    }

    return {
      text,
      metadata: withoutUndefined({
        provider: "openai",
        model: response.model ?? this.model,
        responseId: response.id,
        usage: normalizeOpenAIUsage(response.usage),
      }),
    };
  }

  private async createCompletion(
    request: OpenAIChatCompletionRequest,
  ): Promise<OpenAIChatCompletionResponse> {
    try {
      return await this.client.chat.completions.create(request);
    } catch (cause) {
      throw new Error("openai_chat_completion_request_failed", { cause });
    }
  }
}

const completionTextError = (
  choice: OpenAIChatCompletionResponse["choices"][number],
): Error => {
  const refusal = choice.message?.refusal?.trim();
  if (refusal) {
    return new Error(`openai_chat_completion_refusal: ${refusal}`);
  }
  if (choice.finish_reason === "length") {
    return new Error("openai_chat_completion_truncated: finish_reason=length");
  }
  if (choice.finish_reason) {
    return new Error(`openai_chat_completion_missing_text: finish_reason=${choice.finish_reason}`);
  }
  return new Error("openai_chat_completion_missing_text");
};
