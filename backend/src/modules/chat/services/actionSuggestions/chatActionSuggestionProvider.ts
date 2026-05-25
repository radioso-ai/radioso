import type { MessageRecord } from "../../../../db/repositories/messageRepository.js";
import type { ChatSuggestion } from "../../types/chatResponses.js";
import type { AssistantTurnOutcome, SkillTurnStatus } from "../assistantTurnOutcomeTypes.js";

export interface ChatActionSuggestionContext {
  workspaceId: string;
  conversationId: string;
  agentId?: string;
  query: string;
  answer: string;
  skillName: string;
  skillOutcome: string;
  skillStatus: SkillTurnStatus;
  answerOutcome?: AssistantTurnOutcome;
  history: MessageRecord[];
  userExpectedLocale?: string;
  sourceChannel?: string | null;
  sourceOrigin?: string | null;
}

export interface ChatActionSuggestionProvider {
  readonly name: string;
  evaluate(context: ChatActionSuggestionContext): Promise<ChatSuggestion | null>;
}
