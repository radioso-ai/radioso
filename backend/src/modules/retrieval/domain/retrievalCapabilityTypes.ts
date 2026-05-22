import type { ChatCitation } from "../../chat/contracts/answerTypes.js";
import type { RetrievalExecutionSurface, ActivityTrace, ResponseIntent } from "./retrievalPipelineTypes.js";
import type { ActivitySummary } from "./retrievalPipelineTypes.js";

export interface RetrievalConversationContext {
  previousUserMessages?: string[];
  previousAssistantMessages?: string[];
  followUpToMessageId?: string;
}

export interface RetrievalSearchRequest {
  workspaceId: string;
  query: string;
  metadataFilter?: Record<string, unknown>;
  topK?: number;
  executionSurface?: Extract<RetrievalExecutionSurface, "retrieval" | "mcp_capability">;
}

export interface RetrievalSearchResult {
  outcome: "results";
  rewrittenQuery: {
    semantic: string;
    lexical: string;
  };
  results: Array<{
    documentId: string;
    chunkId: string;
    title: string;
    content: string;
    metadata?: Record<string, unknown>;
    score?: number;
  }>;
  activitySummary: ActivitySummary;
  activityTrace: ActivityTrace;
}

export interface RetrievalAnswerRequest {
  workspaceId: string;
  query: string;
  conversationContext?: RetrievalConversationContext;
  metadataFilter?: Record<string, unknown>;
  executionSurface?: Extract<RetrievalExecutionSurface, "retrieval" | "mcp_capability">;
}

export interface RetrievalAnswerSuccess {
  outcome: "answer";
  answer: string;
  citations?: ChatCitation[];
  evidence: Array<{
    documentId: string;
    chunkId: string;
    title: string;
    content: string;
    metadata?: Record<string, unknown>;
  }>;
  activitySummary: ActivitySummary;
  activityTrace: ActivityTrace;
}

export interface RetrievalAnswerUnsupported {
  outcome: "unsupported";
  code: "unsupported_query_type";
  reason: Exclude<ResponseIntent, "retrieval">;
  message: "This request is outside retrieval scope.";
}

export type RetrievalAnswerResult = RetrievalAnswerSuccess | RetrievalAnswerUnsupported;
