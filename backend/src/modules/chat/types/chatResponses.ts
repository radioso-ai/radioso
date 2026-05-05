import type { AnswerSegment, ChatCitation } from "../services/answerPresentationService.js";
import type { RetrievalTrace } from "../../retrieval/domain/retrievalPipelineTypes.js";
import type { RetrievalInfo } from "../../retrieval/services/retrievalInfoPresenter.js";
import type { ConversationMode } from "../../settings/domain/retrievalSettings.js";

export type ChatSuggestionKind = "deeper" | "broader";

export interface ChatSuggestion {
  text: string;
  kind: ChatSuggestionKind;
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

export interface ChatRoute {
  type: "direct" | "retrieval";
  reason: "assistant_identity" | "conversation_start" | "evidence_required" | "social_only";
}

export interface ChatResponse {
  conversationId: string;
  route: ChatRoute;
  answer: string;
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
  suggestions?: ChatSuggestion[];
  conversationMode: ConversationMode;
  conversationModeMetadata: ConversationModeMetadata;
  retrievalInfo: RetrievalInfo;
  retrievalTrace: RetrievalTrace;
}

export type ChatBootstrapResponse = Omit<ChatResponse, "conversationId"> & {
  conversationId?: string;
};
