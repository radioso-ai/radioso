import type { ConversationMode } from "../../settings/domain/retrievalSettings.js";

export interface ConversationModeInstructionInput {
  conversationMode: ConversationMode;
  brevityOverrideRequested?: boolean;
}

export class ConversationModeInstructionBuilder {
  build(input: ConversationModeInstructionInput): string {
    if (input.brevityOverrideRequested) {
      return [
        "Current turn override: the user explicitly asked for a brief or direct answer.",
        "Answer the question directly.",
        "Do not add any optional focused or expansive continuation unless clarification is required for honesty.",
      ].join("\n");
    }

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
          "After the direct answer, you may optionally mention two or three grounded adjacent directions drawn from the retrieved material.",
          "Any optional continuation must stay grounded in the retrieved material and remain in the same language as the user's question.",
        ].join("\n");
      case "guided":
      default:
        return [
          "Conversation mode: guided.",
          "After the direct answer, you may optionally suggest one or two grounded adjacent directions.",
          "Keep any optional continuation concise, clearly separate from the direct answer, and in the same language as the user's question.",
        ].join("\n");
    }
  }
}
