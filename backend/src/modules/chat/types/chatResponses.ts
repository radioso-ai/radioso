import type { AnswerSegment, ChatCitation } from "../services/answerPresentationService.js";
import type { RetrievalTrace } from "../../retrieval/domain/retrievalPipelineTypes.js";
import type { RetrievalInfo } from "../../retrieval/services/retrievalInfoPresenter.js";
import type { ConversationMode } from "../../settings/domain/retrievalSettings.js";

export interface ChatSuggestion {
  text: string;
  citation?: ChatCitation;
}

export interface ConversationModeMetadata {
  conversationMode: ConversationMode;
  brevityOverrideApplied: boolean;
  expansionApplied: boolean;
  expansionKind: "none" | "focused" | "expansive";
  suggestionCount: number;
  followUpQuestionApplied: boolean;
}

export interface ChatResponse {
  conversationId: string;
  answer: string;
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
  suggestions?: ChatSuggestion[];
  conversationMode: ConversationMode;
  conversationModeMetadata: ConversationModeMetadata;
  retrievalInfo: RetrievalInfo;
  retrievalTrace: RetrievalTrace;
}
