import type { ConversationModelGateway } from "@radioso/conversation-contract";

export interface ConversationKitModelGatewayOptions {
  modelGateway?: ConversationModelGateway;
}

/**
 * The kit needs a model, never a particular vendor: the host supplies the gateway.
 * Vendor factories live behind their own entry point (`@radioso/conversation-kit/openai`)
 * so composing a kit never loads a provider SDK.
 */
export const createConversationKitModelGateway = (
  options: ConversationKitModelGatewayOptions,
): ConversationModelGateway => {
  if (!options.modelGateway) {
    throw new Error("conversation_kit_model_gateway_required");
  }
  return options.modelGateway;
};
