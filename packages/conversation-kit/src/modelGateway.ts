import type { ConversationModelGateway } from "@radioso/conversation-contract";
import { OpenAIConversationModelGateway } from "@radioso/conversation-nlp";

export const DEFAULT_OPENAI_MODEL = "gpt-5.2";

export interface ConversationKitModelGatewayOptions {
  modelGateway?: ConversationModelGateway;
  openAiApiKey?: string;
  openAiModel?: string;
}

export const createConversationKitModelGateway = (
  options: ConversationKitModelGatewayOptions,
): ConversationModelGateway => {
  if (options.modelGateway) {
    return options.modelGateway;
  }
  if (!options.openAiApiKey) {
    throw new Error("conversation_kit_model_gateway_required");
  }
  return new OpenAIConversationModelGateway({
    apiKey: options.openAiApiKey,
    model: options.openAiModel ?? DEFAULT_OPENAI_MODEL,
  });
};
