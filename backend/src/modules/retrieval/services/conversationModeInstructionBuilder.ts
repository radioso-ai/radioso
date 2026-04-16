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
          'After the direct answer, you may add an "Explore further:" block with two or three grounded avenues drawn from the retrieved material.',
          "Any optional follow-up question must stay grounded in the retrieved material and be clearly separate from the direct answer.",
        ].join("\n");
      case "guided":
      default:
        return [
          "Conversation mode: guided.",
          'After the direct answer, you may add a short "Focused next:" block with one or two grounded adjacent directions.',
          "Keep the optional continuation clearly separate from the direct answer.",
        ].join("\n");
    }
  }
}
