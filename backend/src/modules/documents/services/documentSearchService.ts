import { randomUUID } from "node:crypto";
import {
  createNoopWorkspaceInvalidationPublisher,
  type WorkspaceInvalidationPublisher,
} from "@radioso/workspace-invalidation-contract";

import type { AuditService } from "../../audit/contracts/index.js";
import type { DocumentRepositoryPort, DocumentSummaryRecord } from "./documentIngestionService.js";
import type { RetrievalPipelineService, ActivityTrace } from "../../retrieval/public.js";
import {
  readRequestedDateRange,
  type RequestedDateRange,
  type RequestedDateRangeLookupSummary,
  type RequestedDateRangeSearchPort,
} from "../../retrieval/public.js";
import { badRequest } from "../../../shared/domain/errors.js";

// Not exported: nothing outside this module names a search action directly; callers only ever
// see it nested inside DocumentSearchAction, which is exported.
type DocumentSearchActionType =
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
  /** Whether this document had a chunk the requested-range lookup placed inside the range;
   * `null` when no range was requested. */
  datedInRequestedRange: boolean | null;
}

export interface DocumentSearchResponse {
  searchId: string;
  mode: "live" | "snapshot";
  query: string;
  resultCount: number;
  results: DocumentSearchResult[];
  /** Whether a requested range was asked for, and if so, whether the structured lookup ran,
   * failed, and how many candidates it contributed. */
  dateRangeLookup: RequestedDateRangeLookupSummary;
  activityTrace?: ActivityTrace;
}

// Not exported: callers pass the literal string; nothing outside this module names the type.
type DocumentSearchExecutionSurface = "documents" | "mcp_capability" | "operator_copilot";

interface DocumentSearchAuditMetadata extends Record<string, unknown> {
  searchId: string;
  resultCount: number;
  query?: string;
  results?: DocumentSearchResult[];
  dateRangeLookup?: DocumentSearchResponse["dateRangeLookup"];
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
    /** Wired only where the requested-range lookup can run; absent, a range input is refused.
     * Owns the embedding, dimension guarding, date-order degradation, and depth rule a requested
     * range needs — this service only resolves the range, merges the port's chunks with the
     * similarity results, and orders the merge. */
    private readonly requestedDateRangeSearch?: RequestedDateRangeSearchPort,
  ) {}

  async search(input: {
    workspaceId: string;
    query: string;
    metadataFilter?: Record<string, unknown>;
    executionSurface?: DocumentSearchExecutionSurface;
    /** Ray's own conversation and this turn's operator message, set only when
     * `executionSurface` is `"operator_copilot"`; never the assistant's own ids. */
    copilotConversationId?: string;
    copilotMessageId?: string;
    /** An explicit period to prefer, both or neither. Validated the same way the assistant's
     * own query interpretation validates a model-resolved range. */
    dateFrom?: string;
    dateTo?: string;
  }): Promise<DocumentSearchResponse> {
    const searchId = randomUUID();
    const requestedDateRange = this.resolveRequestedDateRange(input.dateFrom, input.dateTo);
    const usageContext = {
      workspaceId: input.workspaceId,
      requestId: searchId,
      surface: input.executionSurface ?? "documents",
      attemptKey: "document_search",
      copilotConversationId: input.copilotConversationId ?? null,
      copilotMessageId: input.copilotMessageId ?? null,
    };
    const retrieval = await this.retrievalPipeline.run({
      workspaceId: input.workspaceId,
      query: input.query,
      history: [],
      metadataFilter: input.metadataFilter,
      usageContext,
    });

    const dateRangeLookup = requestedDateRange
      ? await this.resolveDateRangeLookup(input.workspaceId, input.query, requestedDateRange, input.metadataFilter, usageContext)
      : { status: "not_requested" as const, chunks: [] };

    const matchedDocumentIds = [...new Set([
      ...dateRangeLookup.chunks.map((chunk) => chunk.documentId),
      ...retrieval.contexts.map((context) => context.documentId),
    ])];
    const documents = await this.documentRepository.listSummariesByIdsAndWorkspaceId(input.workspaceId, matchedDocumentIds);
    const documentsById = new Map(documents.map((document) => [document.id, document]));
    const aggregated = new Map<string, { document: DocumentSummaryRecord; score: number; evidence: string[]; datedInRequestedRange: boolean }>();

    const merge = (documentId: string, score: number, content: string, datedInRequestedRange: boolean) => {
      const document = documentsById.get(documentId);
      if (!document) {
        return;
      }

      const evidence = buildEvidence(content);
      const current = aggregated.get(document.id);
      if (!current) {
        aggregated.set(document.id, { document, score, evidence, datedInRequestedRange });
        return;
      }

      current.datedInRequestedRange ||= datedInRequestedRange;
      current.score = Math.max(current.score, score);
      current.evidence = [...current.evidence, ...evidence].slice(0, 3);
    };

    // Merged first: the requested-range lookup is a calendar match, guaranteed in range by
    // construction, independent of whatever the similarity search below ranked it.
    for (const chunk of dateRangeLookup.chunks) {
      merge(chunk.documentId, chunk.similarity ?? 0, chunk.content, true);
    }
    for (const context of retrieval.contexts) {
      merge(context.documentId, context.relevanceScore ?? context.semanticScore ?? context.similarity ?? 0, context.content, false);
    }

    const results = [...aggregated.values()]
      .sort((left, right) => {
        if (left.datedInRequestedRange !== right.datedInRequestedRange) {
          return left.datedInRequestedRange ? -1 : 1;
        }
        return right.score - left.score;
      })
      .map((entry, index) => this.toResult(
        entry.document,
        entry.score,
        entry.evidence,
        index + 1,
        requestedDateRange ? entry.datedInRequestedRange : null,
      ));

    const response: DocumentSearchResponse = {
      searchId,
      mode: "live",
      query: input.query,
      resultCount: results.length,
      results,
      dateRangeLookup: {
        status: dateRangeLookup.status,
        candidateCount: dateRangeLookup.status === "ran" ? dateRangeLookup.chunks.length : 0,
      },
      activityTrace: retrieval.trace,
    };

    const metadata: DocumentSearchAuditMetadata = {
      searchId: response.searchId,
      resultCount: response.resultCount,
      executionSurface: input.executionSurface ?? "documents",
      ...(input.executionSurface === "operator_copilot" ? {} : {
        query: response.query,
        results: response.results,
        dateRangeLookup: response.dateRangeLookup,
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

  /** Both-or-neither; the same rules `readRequestedDateRange` applies to a model-resolved range. */
  private resolveRequestedDateRange(dateFrom: string | undefined, dateTo: string | undefined): RequestedDateRange | null {
    if (dateFrom === undefined && dateTo === undefined) {
      return null;
    }
    if (dateFrom === undefined || dateTo === undefined) {
      throw badRequest("Provide both dateFrom and dateTo, or neither");
    }

    const reading = readRequestedDateRange({ dateFrom, dateTo });
    if (!reading.range) {
      throw badRequest(
        reading.dropReason === "too_long"
          ? "dateFrom to dateTo spans too many days"
          : "dateFrom and dateTo must be valid ISO calendar dates, with dateFrom on or before dateTo",
      );
    }
    return reading.range;
  }

  private async resolveDateRangeLookup(
    workspaceId: string,
    query: string,
    range: RequestedDateRange,
    metadataFilter: Record<string, unknown> | undefined,
    usageContext: { workspaceId: string; requestId: string; surface: string; attemptKey: string; copilotConversationId: string | null; copilotMessageId: string | null },
  ) {
    if (!this.requestedDateRangeSearch) {
      throw badRequest("Date-range search is unavailable on this surface.", { code: "document_search_date_range_unavailable" });
    }

    return this.requestedDateRangeSearch.search({
      workspaceId,
      query,
      range,
      ...(metadataFilter ? { metadataFilter } : {}),
      usageContext,
    });
  }

  private toResult(
    document: DocumentSummaryRecord,
    score: number,
    evidence: string[],
    rank: number,
    datedInRequestedRange: boolean | null,
  ): DocumentSearchResult {
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
      datedInRequestedRange,
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
