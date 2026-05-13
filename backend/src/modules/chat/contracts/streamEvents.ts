import type { RetrievalInfo, RetrievalTrace } from "../../retrieval/public.js";
import type { AnswerSegment, ChatCitation } from "./answerTypes.js";
import type { ChatRoute, ChatSuggestion } from "../types/chatResponses.js";

export type ChatStreamEvent =
  | { type: "conversation"; conversationId: string }
  | { type: "chunk"; text: string }
  | {
      type: "suggestions";
      conversationId: string;
      suggestions: ChatSuggestion[];
    }
  | {
      type: "done";
      conversationId: string;
      agentId?: string;
      agentName?: string;
      assistantMessageId: string;
      answer: string;
      citations?: ChatCitation[];
      answerSegments?: AnswerSegment[];
      suggestions?: ChatSuggestion[];
      retrievalInfo: RetrievalInfo;
      retrievalTrace: RetrievalTrace;
      route: ChatRoute;
    };
