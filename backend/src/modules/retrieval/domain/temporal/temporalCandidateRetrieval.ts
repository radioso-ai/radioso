import type { RetrievalSourceFilter } from "../retrievalSourceFilter.js";
import type { RetrievedChunk } from "../vectorSearch.js";

export interface TemporalCandidateRetrievalInput {
  workspaceId: string;
  today: string;
  topK: number;
  metadataFilter?: Record<string, unknown>;
  sourceFilter?: RetrievalSourceFilter;
}

export interface TemporalCandidateRetrievalPort {
  findUpcoming(input: TemporalCandidateRetrievalInput): Promise<RetrievedChunk[]>;
}
