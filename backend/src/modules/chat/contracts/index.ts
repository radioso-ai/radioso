import type { ChatResponse } from "../types/chatResponses.js";

export type {
  AnswerSegment,
  ChatCitation,
  CitationEvidence,
  NormalizedPresentedAnswer,
  PresentedAnswer,
} from "./answerTypes.js";
export type { ChatActionProviderPort } from "../services/chatActionProvider.js";
export type { ChatGateway } from "./chatGateway.js";
export type { ChatStreamEvent } from "./streamEvents.js";
export type {
  ContactHistoryDetail,
  ContactHistoryPage,
  ContactHistoryProviderPort,
  ContactHistorySummary,
} from "../services/contactHistoryProvider.js";
export type {
  ChatBootstrapResponse,
  ChatResponse,
  ChatRoute,
  ChatSuggestion,
  ChatSuggestionKind,
  ConversationModeMetadata,
} from "../types/chatResponses.js";

export interface ChatAnswerPort {
  answer(input: {
    workspaceId: string;
    accountId?: string;
    conversationId?: string;
    query: string;
    stream: boolean;
    userExpectedLocale?: string | null;
    inputMetadata?: unknown;
    metadataFilter?: Record<string, unknown>;
    pageContext?: unknown;
    sourceChannel?: string | null;
    anonymousSessionId?: string | null;
    sourceOrigin?: string | null;
  }): Promise<ChatResponse>;
}
