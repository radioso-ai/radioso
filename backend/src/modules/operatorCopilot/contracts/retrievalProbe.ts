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
}

export interface CopilotRetrievalProbeResult {
  agentId: string;
  retrievalEnabled: boolean;
  rewrittenQuery: { semantic: string; lexical: string };
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
    results: ReadonlyArray<CopilotRetrievalEvidence>;
  }>;
}

export interface RetrievalProbeServiceDependencies extends CopilotExpensiveOperationGuardDependencies {
  retrievalSearch: CopilotRetrievalSearchPort;
}
