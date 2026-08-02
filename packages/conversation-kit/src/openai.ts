import type { ConversationModelGateway } from "@radioso/conversation-contract";
import { OpenAIConversationModelGateway } from "@radioso/conversation-nlp";

export const DEFAULT_OPENAI_MODEL = "gpt-5.2";

export interface CreateOpenAIModelGatewayOptions {
  apiKey: string;
  model?: string;
}

/**
 * An OpenAI-backed {@link ConversationModelGateway}. It builds a gateway rather than a
 * kit, so the same value composes with `createConversationKit`,
 * `createConversationKitClient`, and `createConversationKitServer`, and no vendor field
 * has to exist on any of their option types.
 *
 * Requires `@radioso/conversation-nlp`, which carries the OpenAI SDK.
 */
export const createOpenAIModelGateway = (
  options: CreateOpenAIModelGatewayOptions,
): ConversationModelGateway =>
  new OpenAIConversationModelGateway({
    apiKey: options.apiKey,
    model: options.model ?? DEFAULT_OPENAI_MODEL,
  });
