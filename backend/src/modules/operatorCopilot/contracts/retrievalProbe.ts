import type { RequestedDateRange, RequestedDateRangeDropReason } from "../../retrieval/public.js";
import type { CopilotExpensiveOperationGuardDependencies } from "./expensiveOperation.js";

export interface CopilotRetrievalProbeInput {
  workspaceId: string;
  accountId: string;
  operatorUserId: string;
  agentId: string;
  query: string;
  topK?: number;
  metadataFilter?: Record<string, unknown>;
}

export interface CopilotRetrievalEvidence {
  documentId: string;
  chunkId: string;
  title: string;
  content: string;
  score?: number;
  /** The chunk's own dates from metadata, independent of whether a range was requested. */
  dateFrom: string | null;
  dateTo: string | null;
  /** Whether the chunk's own dates fall inside the resolved `requestedDateRange`; `null` when no range was requested. */
  datedInRequestedRange: boolean | null;
  /** Whether this result came from the requested-range structured lookup rather than semantic or lexical search. */
  fromRequestedRangeLookup: boolean;
}

/** How many candidates the requested-range structured lookup contributed, and whether it ran at all. */
export interface CopilotRequestedRangeLookupSummary {
  ran: boolean;
  candidateCount: number;
}

export interface CopilotRetrievalProbeResult {
  agentId: string;
  retrievalEnabled: boolean;
  rewrittenQuery: { semantic: string; lexical: string };
  /** The period the question resolved to, or `null` when it named none or the model's range was dropped. */
  requestedDateRange: RequestedDateRange | null;
  /** Why a model-returned range was set aside; `null` when one was kept or none was proposed. */
  requestedDateRangeDropReason: RequestedDateRangeDropReason | null;
  requestedRangeLookup: CopilotRequestedRangeLookupSummary;
  results: ReadonlyArray<CopilotRetrievalEvidence>;
}

export interface CopilotRetrievalProbePort {
  probe(input: CopilotRetrievalProbeInput): Promise<CopilotRetrievalProbeResult>;
}

/**
 * The owner module's agent-scoped search, narrowed to what a probe needs. The
 * attribution field is part of the port because refusing an unattributed result
 * is the whole point of the probe.
 */
export interface CopilotRetrievalSearchPort {
  search(input: {
    workspaceId: string;
    accountId?: string | null;
    agentId: string;
    query: string;
    topK?: number;
    metadataFilter?: Record<string, unknown>;
  }): Promise<{
    agentScope: { agentId: string; retrievalEnabled: boolean } | null;
    rewrittenQuery: { semantic: string; lexical: string };
    requestedDateRange: RequestedDateRange | null;
    requestedDateRangeDropReason: RequestedDateRangeDropReason | null;
    requestedRangeLookup: CopilotRequestedRangeLookupSummary;
    results: ReadonlyArray<CopilotRetrievalEvidence>;
  }>;
}

export interface RetrievalProbeServiceDependencies extends CopilotExpensiveOperationGuardDependencies {
  retrievalSearch: CopilotRetrievalSearchPort;
}
