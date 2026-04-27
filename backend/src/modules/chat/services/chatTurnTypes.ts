import type { ConversationRecord } from "../../../db/repositories/conversationRepository.js";
import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { RetrievalPipelineService } from "../../retrieval/services/retrievalPipelineService.js";
import type { RewriteContinuityState } from "../../retrieval/domain/retrievalPipelineTypes.js";
import type { ChatTurnRoute } from "./chatTurnIntentService.js";
import type { AnswerSegment, ChatCitation } from "./answerPresentationService.js";
import type {
  AnswerSegmentValidationResult,
  AnswerValidationSummary,
  AssistantTurnOutcome,
} from "./answerSupportValidationTypes.js";
import type { ConversationModeMetadata, ChatSuggestion } from "../types/chatResponses.js";

export interface PreparedSession {
  conversation: ConversationRecord;
  history: MessageRecord[];
  retrieval: Awaited<ReturnType<RetrievalPipelineService["run"]>>;
  turnRoute: ChatTurnRoute;
  userMessage: MessageRecord;
  priorRewriteContinuityState?: RewriteContinuityState;
}

export interface PresentedAnswer {
  answer: string;
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
  suggestions?: ChatSuggestion[];
  planningCitations?: ChatCitation[];
  answerOutcome: AssistantTurnOutcome;
  validation: AnswerValidationSummary;
  segmentResults: AnswerSegmentValidationResult[];
  conversationModeMetadata: ConversationModeMetadata;
}
