import type { AnswerSegment, ChatCitation } from "../contracts/answerTypes.js";
import type { RetrievalInfo, RetrievalTrace } from "../../retrieval/public.js";
import type { ConversationMode } from "../../settings/contracts/retrieval.js";

export type ChatSuggestionKind = string;

export interface ChatSuggestion {
  text: string;
  kind: ChatSuggestionKind;
  citation?: ChatCitation;
  action?: {
    kind: string;
    payload?: Record<string, unknown>;
  };
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
  agentId?: string;
  agentName?: string;
  assistantMessageId: string;
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

export type ChatBootstrapResponse = Omit<ChatResponse, "conversationId" | "assistantMessageId"> & {
  conversationId?: string;
  assistantMessageId?: string;
};
