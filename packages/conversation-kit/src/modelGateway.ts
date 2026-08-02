import type { ConversationModelGateway } from "@radioso/conversation-contract";

export interface ConversationKitModelGatewayOptions {
  modelGateway?: ConversationModelGateway;
}

/**
 * Resolves the host-supplied gateway the kit talks to. Vendor choice belongs to the
 * host, so a gateway is the one thing every kit needs handed to it.
 */
export const createConversationKitModelGateway = (
  options: ConversationKitModelGatewayOptions,
): ConversationModelGateway => {
  if (!options.modelGateway) {
    throw new Error("conversation_kit_model_gateway_required");
  }
  return options.modelGateway;
};
