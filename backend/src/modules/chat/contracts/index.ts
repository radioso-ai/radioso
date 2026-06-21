import type { ChatResponse } from "../types/chatResponses.js";

export type {
  AnswerSegment,
  ChatCitation,
  CitationEvidence,
  NormalizedPresentedAnswer,
  PresentedAnswer,
} from "./answerTypes.js";
export type {
  PublicChatActionAdvertiserPort,
} from "../services/publicChatActionAdvertiser.js";
export type { ChatGateway } from "./chatGateway.js";
export type { AssistantTurnOutcome } from "../services/assistantTurnOutcomeTypes.js";
export { ASSISTANT_TURN_OUTCOME } from "../services/assistantTurnOutcomeTypes.js";
export { appendDirectiveSteeringStage } from "../services/directiveTracePresenter.js";
export type { TurnTraceEnvelope } from "../services/turnTraceEnvelope.js";
export type { ChatStreamEvent } from "./streamEvents.js";
export type {
  ActionHandler,
  ActionHandlerContext,
} from "../services/actions/actionDispatcher.js";
export { CitationAnchorSanitizer } from "../services/citationAnchorSanitizer.js";
export type {
  ContactHistoryDetail,
  ContactHistoryPage,
  ContactHistoryProviderPort,
  ContactHistorySummary,
} from "../services/contactHistoryProvider.js";
export type { PublicChatIntakeAction } from "../services/publicChatActionAdvertiser.js";
export type {
  ChatBootstrapResponse,
  ChatResponse,
  ChatRoute,
  ChatSuggestion,
  ChatSuggestionKind,
} from "../types/chatResponses.js";

export interface ChatAnswerPort {
  answer(input: {
    workspaceId: string;
    agentId?: string | null;
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
