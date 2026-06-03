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
  OpenAIConversationModelGatewayOptions,
} from "./openAiTypes.js";

export class OpenAIConversationModelGateway implements ConversationModelGateway {
  private readonly client: OpenAIChatClient;
  private readonly model: string;
  private readonly reasoningEffort?: OpenAIConversationModelGatewayOptions["reasoningEffort"];

  constructor(options: OpenAIConversationModelGatewayOptions) {
    this.client = options.client ?? (options.apiKey ? new OpenAI({ apiKey: options.apiKey }) : new OpenAI());
    this.model = options.model;
    this.reasoningEffort = options.reasoningEffort;
  }

  async complete(input: {
    messages: ConversationMessage[];
    systemPrompt?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ text: string; metadata?: Record<string, unknown> }> {
    const request: OpenAIChatCompletionRequest = {
      model: this.model,
      messages: toOpenAIChatMessages(input),
      ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
    };
    const response = await this.client.chat.completions.create(request);
    const text = response.choices[0]?.message?.content?.trim();
    if (!text) {
      throw new Error("openai_chat_completion_missing_text");
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
}
