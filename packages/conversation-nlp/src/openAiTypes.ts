export type OpenAIReasoningEffort = "minimal" | "low" | "medium" | "high";

export type OpenAIChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string }
  | { role: "tool"; content: string; tool_call_id: string };

export interface OpenAIChatCompletionRequest {
  model: string;
  messages: OpenAIChatMessage[];
  reasoning_effort?: OpenAIReasoningEffort;
}

export interface OpenAIChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: unknown;
  completion_tokens_details?: unknown;
}

export interface OpenAIChatCompletionResponse {
  id?: string;
  model?: string;
  choices: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      refusal?: string | null;
    };
  }>;
  usage?: OpenAIChatUsage;
}

export interface OpenAIChatClient {
  chat: {
    completions: {
      create(input: OpenAIChatCompletionRequest): Promise<OpenAIChatCompletionResponse>;
    };
  };
}

export interface OpenAIConversationModelGatewayOptions {
  client?: OpenAIChatClient;
  apiKey?: string;
  model: string;
  reasoningEffort?: OpenAIReasoningEffort;
  supportsReasoningEffort?: boolean;
}
