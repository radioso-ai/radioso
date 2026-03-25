import { notFound } from "../../../shared/domain/errors.js";
import type { AuditEventRepositoryPort } from "../../../db/repositories/auditEventRepository.js";
import type { DocumentRepositoryPort } from "./documentIngestionService.js";
import { defaultActions, type DocumentSearchResponse, type DocumentSearchResult } from "./documentSearchService.js";

interface DocumentSearchAuditMetadata extends Record<string, unknown> {
  searchId: string;
  query: string;
  resultCount: number;
  results: DocumentSearchResult[];
  retrievalTrace?: import("../../retrieval/domain/retrievalPipelineTypes.js").RetrievalTrace;
}

export interface DocumentSearchHistoryEntry {
  searchId: string;
  query: string;
  createdAt: string;
  resultCount: number;
  traceAvailable: boolean;
  previewTopTitles: string[];
}

export class DocumentSearchHistoryService {
  constructor(
    private readonly auditEventRepository: AuditEventRepositoryPort,
    private readonly documentRepository: DocumentRepositoryPort,
  ) {}

  async listHistory(workspaceId: string): Promise<DocumentSearchHistoryEntry[]> {
    const events = await this.auditEventRepository.listDocumentSearchEventsByWorkspaceId(workspaceId);

    return events.map((event) => {
      const metadata = normalizeAuditMetadata(event.metadata, event.id);
      return {
        searchId: metadata.searchId,
        query: metadata.query,
        createdAt: event.createdAt.toISOString(),
        resultCount: metadata.resultCount,
        traceAvailable: Boolean(metadata.retrievalTrace),
        previewTopTitles: metadata.results.slice(0, 3).map((result) => result.title),
      };
    });
  }

  async getHistory(workspaceId: string, searchId: string): Promise<DocumentSearchResponse> {
    const event = await this.auditEventRepository.findDocumentSearchEventBySearchId(workspaceId, searchId);
    if (!event) {
      throw notFound("Document search not found");
    }

    const metadata = normalizeAuditMetadata(event.metadata, searchId);
    const results = await Promise.all(
      metadata.results.map(async (result) => {
        const document = await this.documentRepository.findByIdAndWorkspaceId(result.documentId, workspaceId);
        return {
          ...result,
          actions: document ? defaultActions("available") : defaultActions("unavailable"),
        };
      }),
    );

    return {
      searchId: metadata.searchId,
      mode: "snapshot",
      query: metadata.query,
      resultCount: metadata.resultCount,
      results,
      retrievalTrace: metadata.retrievalTrace,
    };
  }
}

const LEGACY_QUERY_LABEL = "Legacy search";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

const normalizeResult = (value: unknown): DocumentSearchResult | null => {
  if (!isRecord(value)) {
    return null;
  }

  const documentId = asString(value.documentId);
  const title = asString(value.title);
  if (!documentId || !title) {
    return null;
  }

  return {
    documentId,
    title,
    status: asString(value.status) ?? "unknown",
    ragStatus: value.ragStatus === "processed" ? "processed" : "pending",
    metadata: isRecord(value.metadata) ? value.metadata : {},
    score: asNumber(value.score) ?? 0,
    rank: asNumber(value.rank) ?? 0,
    matchEvidence: Array.isArray(value.matchEvidence)
      ? value.matchEvidence.filter((entry): entry is string => typeof entry === "string")
      : [],
    sourceKind: value.sourceKind === "uploaded_file" ? "uploaded_file" : "inline_text",
    sourceFilename: asString(value.sourceFilename) ?? null,
    sourceMimeType: asString(value.sourceMimeType) ?? null,
    actions: defaultActions("unavailable"),
  };
};

const normalizeAuditMetadata = (metadata: unknown, fallbackSearchId: string): DocumentSearchAuditMetadata => {
  const safeMetadata = isRecord(metadata) ? metadata : {};
  const results = Array.isArray(safeMetadata.results)
    ? safeMetadata.results.map(normalizeResult).filter((result): result is DocumentSearchResult => result !== null)
    : [];

  return {
    searchId: asString(safeMetadata.searchId) ?? fallbackSearchId,
    query: asString(safeMetadata.query) ?? LEGACY_QUERY_LABEL,
    resultCount: asNumber(safeMetadata.resultCount) ?? results.length,
    results,
    retrievalTrace: isRecord(safeMetadata.retrievalTrace)
      ? (safeMetadata.retrievalTrace as unknown as DocumentSearchAuditMetadata["retrievalTrace"])
      : undefined,
  };
};
