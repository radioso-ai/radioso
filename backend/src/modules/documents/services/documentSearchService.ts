import { randomUUID } from "node:crypto";
import {
  createNoopWorkspaceInvalidationPublisher,
  type WorkspaceInvalidationPublisher,
} from "@radioso/workspace-invalidation-contract";

import type { AuditService } from "../../audit/contracts/index.js";
import type { DocumentRepositoryPort, DocumentSummaryRecord } from "./documentIngestionService.js";
import type { RetrievalPipelineService, ActivityTrace } from "../../retrieval/public.js";

export type DocumentSearchActionType =
  | "open_document"
  | "inspect_match_evidence"
  | "open_history_entry"
  | "rerun_search";

export interface DocumentSearchAction {
  type: DocumentSearchActionType;
  status: "available" | "unavailable";
}

export interface DocumentSearchResult {
  documentId: string;
  title: string;
  status: string;
  ragStatus: "processed" | "pending";
  metadata: Record<string, unknown>;
  score: number;
  rank: number;
  matchEvidence: string[];
  sourceKind: DocumentSummaryRecord["sourceKind"];
  sourceFilename?: string | null;
  sourceMimeType?: string | null;
  actions: DocumentSearchAction[];
}

export interface DocumentSearchResponse {
  searchId: string;
  mode: "live" | "snapshot";
  query: string;
  resultCount: number;
  results: DocumentSearchResult[];
  activityTrace?: ActivityTrace;
}

export type DocumentSearchExecutionSurface = "documents" | "mcp_capability" | "operator_copilot";

interface DocumentSearchAuditMetadata extends Record<string, unknown> {
  searchId: string;
  resultCount: number;
  query?: string;
  results?: DocumentSearchResult[];
  activityTrace?: ActivityTrace;
  executionSurface: DocumentSearchExecutionSurface;
}

export class DocumentSearchService {
  constructor(
    private readonly documentRepository: DocumentRepositoryPort,
    private readonly retrievalPipeline: RetrievalPipelineService,
    private readonly auditService: AuditService,
    private readonly workspaceInvalidationPublisher: WorkspaceInvalidationPublisher =
      createNoopWorkspaceInvalidationPublisher(),
  ) {}

  async search(input: {
    workspaceId: string;
    query: string;
    metadataFilter?: Record<string, unknown>;
    executionSurface?: DocumentSearchExecutionSurface;
  }): Promise<DocumentSearchResponse> {
    const searchId = randomUUID();
    const retrieval = await this.retrievalPipeline.run({
      workspaceId: input.workspaceId,
      query: input.query,
      history: [],
      metadataFilter: input.metadataFilter,
      usageContext: {
        workspaceId: input.workspaceId,
        requestId: searchId,
        surface: input.executionSurface ?? "documents",
        attemptKey: "document_search",
      },
    });

    const matchedDocumentIds = [...new Set(retrieval.contexts.map((context) => context.documentId))];
    const documents = await this.documentRepository.listSummariesByIdsAndWorkspaceId(input.workspaceId, matchedDocumentIds);
    const documentsById = new Map(documents.map((document) => [document.id, document]));
    const aggregated = new Map<string, { document: DocumentSummaryRecord; score: number; evidence: string[] }>();

    for (const context of retrieval.contexts) {
      const document = documentsById.get(context.documentId);
      if (!document) {
        continue;
      }

      const score = context.relevanceScore ?? context.semanticScore ?? context.similarity ?? 0;
      const evidence = buildEvidence(context.content);
      const current = aggregated.get(document.id);
      if (!current) {
        aggregated.set(document.id, { document, score, evidence });
        continue;
      }

      current.score = Math.max(current.score, score);
      current.evidence = [...current.evidence, ...evidence].slice(0, 3);
    }

    const results = [...aggregated.values()]
      .sort((left, right) => right.score - left.score)
      .map((entry, index) => this.toResult(entry.document, entry.score, entry.evidence, index + 1));

    const response: DocumentSearchResponse = {
      searchId,
      mode: "live",
      query: input.query,
      resultCount: results.length,
      results,
      activityTrace: retrieval.trace,
    };

    const metadata: DocumentSearchAuditMetadata = {
      searchId: response.searchId,
      resultCount: response.resultCount,
      executionSurface: input.executionSurface ?? "documents",
      ...(input.executionSurface === "operator_copilot" ? {} : {
        query: response.query,
        results: response.results,
        activityTrace: response.activityTrace,
      }),
    };

    await this.auditService.record({
      workspaceId: input.workspaceId,
      eventType: "document.search",
      eventStatus: "success",
      metadata,
    });
    this.workspaceInvalidationPublisher.enqueue(input.workspaceId, ["search.created"]);

    return response;
  }

  private toResult(document: DocumentSummaryRecord, score: number, evidence: string[], rank: number): DocumentSearchResult {
    return {
      documentId: document.id,
      title: document.title,
      status: document.status,
      ragStatus: document.status === "ready" ? "processed" : "pending",
      metadata: document.metadata,
      score: Number(score.toFixed(3)),
      rank,
      matchEvidence: evidence,
      sourceKind: document.sourceKind,
      sourceFilename: document.sourceFilename ?? null,
      sourceMimeType: document.sourceMimeType ?? null,
      actions: defaultActions("available"),
    };
  }
}

const buildEvidence = (content: string): string[] => {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return [];
  }

  return [normalized.slice(0, DOCUMENT_BEHAVIOR.searchEvidenceMaxChars)];
};

export const defaultActions = (status: "available" | "unavailable"): DocumentSearchAction[] => [
  { type: "open_document", status },
  { type: "inspect_match_evidence", status: "available" },
  { type: "open_history_entry", status: "available" },
  { type: "rerun_search", status: "available" },
];
import { DOCUMENT_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
