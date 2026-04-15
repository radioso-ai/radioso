import type { AnswerSegment, ChatCitation } from "../services/answerPresentationService.js";
import type { RetrievalTrace } from "../../retrieval/domain/retrievalPipelineTypes.js";
import type { RetrievalInfo } from "../../retrieval/services/retrievalInfoPresenter.js";

export interface ChatResponse {
  conversationId: string;
  answer: string;
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
  retrievalInfo: RetrievalInfo;
  retrievalTrace: RetrievalTrace;
}
