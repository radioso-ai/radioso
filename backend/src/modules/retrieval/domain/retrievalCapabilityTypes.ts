import type { ChatCitation } from "../../chat/contracts/answerTypes.js";
import type { RetrievalExecutionSurface, ActivityTrace } from "./retrievalPipelineTypes.js";
import type { ActivitySummary } from "./retrievalPipelineTypes.js";
import type { RetrievalResponseBehavior } from "../public.js";
import type { RetrievalSourceScope } from "./retrievalSourceFilter.js";
import type { RequestedDateRange, RequestedDateRangeDropReason } from "./temporal/requestedDateRange.js";
import type { RequestedDateRangeLookupSummary } from "./temporal/requestedDateRangeLookupStatus.js";

export interface RetrievalConversationContext {
  previousUserMessages?: string[];
  previousAssistantMessages?: string[];
  followUpToMessageId?: string;
}

/**
 * Attribution for a run that was measured with one agent's configuration.
 * `null` means the run used workspace retrieval defaults and describes no agent.
 */
export interface RetrievalAgentScopeAttribution {
  agentId: string;
  retrievalEnabled: boolean;
}

export interface RetrievalSearchRequest {
  workspaceId: string;
  accountId?: string | null;
  requestId?: string | null;
  agentId?: string | null;
  query: string;
  metadataFilter?: Record<string, unknown>;
  topK?: number;
  executionSurface?: Extract<RetrievalExecutionSurface, "retrieval" | "mcp_capability">;
}

export interface RetrievalSearchResult {
  outcome: "results";
  agentScope: RetrievalAgentScopeAttribution | null;
  rewrittenQuery: {
    semantic: string;
    lexical: string;
  };
  /** The period the question resolved to, or `null` when it named none or the model's range was dropped. */
  requestedDateRange: RequestedDateRange | null;
  /** Why a model-returned range was set aside; `null` when one was kept or none was proposed. */
  requestedDateRangeDropReason: RequestedDateRangeDropReason | null;
  requestedRangeLookup: RequestedDateRangeLookupSummary;
  results: Array<{
    documentId: string;
    chunkId: string;
    title: string;
    content: string;
    metadata?: Record<string, unknown>;
    score?: number;
    /** The chunk's own dates from metadata, independent of whether a range was requested. */
    dateFrom: string | null;
    dateTo: string | null;
    /** Whether the chunk's own dates fall inside `requestedDateRange`; `null` when no range was requested. */
    datedInRequestedRange: boolean | null;
    /** Whether this result came from the requested-range structured lookup rather than semantic or lexical search. */
    fromRequestedRangeLookup: boolean;
  }>;
  activitySummary: ActivitySummary;
  activityTrace: ActivityTrace;
}

export interface RetrievalAnswerRequest {
  workspaceId: string;
  accountId?: string | null;
  requestId?: string | null;
  agentId?: string | null;
  query: string;
  conversationContext?: RetrievalConversationContext;
  metadataFilter?: Record<string, unknown>;
  sourceScope?: RetrievalSourceScope;
  responseBehavior?: RetrievalResponseBehavior;
  responseBehaviorEnabled?: boolean;
  agentSkillSettings?: Record<string, unknown>;
  executionSurface?: Extract<RetrievalExecutionSurface, "retrieval" | "mcp_capability">;
}

export interface RetrievalAnswerSuccess {
  outcome: "answer";
  agentScope: RetrievalAgentScopeAttribution | null;
  answer: string;
  citations?: ChatCitation[];
  evidence: Array<{
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

export type RetrievalAnswerResult = RetrievalAnswerSuccess;
