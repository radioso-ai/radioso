import type { ConversationMode } from "../../settings/domain/retrievalSettings.js";

export interface ConversationModeInstructionInput {
  conversationMode: ConversationMode;
}

export class ConversationModeInstructionBuilder {
  build(input: ConversationModeInstructionInput): string {
    switch (input.conversationMode) {
      case "factual":
        return [
          "Conversation mode: factual.",
          "Answer only the user's question.",
          "Do not proactively add adjacent topics, discovery blocks, or follow-up questions unless clarification is required for honesty.",
        ].join("\n");
      case "exploratory":
        return [
          "Conversation mode: exploratory.",
          "Answer the user's question directly, and stay grounded in the retrieved material.",
          "Do not append generic suggested-question lists or generic closing invitations in the answer body.",
          "Keep the answer in the same language as the user's question.",
        ].join("\n");
      case "guided":
      default:
        return [
          "Conversation mode: guided.",
          "Answer the user's question directly and concisely.",
          "Do not append generic suggested-question lists or generic closing invitations in the answer body.",
          "Keep the answer in the same language as the user's question.",
        ].join("\n");
    }
  }
}
