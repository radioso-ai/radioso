import type { ChatSuggestion } from "../types/chatResponses.js";
import type { AssistantTurnOutcome } from "./answerSupportValidationTypes.js";

export interface ChatActionProviderPort {
  evaluate(input: {
    workspaceId: string;
    accountId?: string | null;
    conversationId: string;
    assistantMessageId: string;
    query: string;
    answer: string;
    answerOutcome: AssistantTurnOutcome;
    sourceChannel?: string | null;
    sourceOrigin?: string | null;
  }): Promise<ChatSuggestion | null>;
  getPublicSessionActions?(input: {
    workspaceId: string;
  }): Promise<Record<string, unknown> | null | undefined>;
}

export class NoopChatActionProvider implements ChatActionProviderPort {
  async evaluate(): Promise<ChatSuggestion | null> {
    return null;
  }
}
