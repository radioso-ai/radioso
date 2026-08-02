import { CONTENT_PLAN_ACTION_POLICY_V1 } from "../domain/opportunityPolicy.js";

const MAX_RELATED_DOCUMENTS = 5;
const SEARCH_CANDIDATE_LIMIT = 20;

export interface ContentPlanningCorpusCandidate {
  id: string;
  title: string;
  possibleRelevance: number;
  createdAt: string;
  updatedAt: string;
}

export interface ContentPlanningCorpusSearchPort {
  /**
   * Returns only documents the workspace is authorized to inspect. Implementations
   * must enforce workspace ownership before applying semantic similarity.
   */
  findRelatedDocuments(input: {
    workspaceId: string;
    embeddingSpaceId: string;
    centroid: readonly number[];
    limit: number;
  }): Promise<readonly ContentPlanningCorpusCandidate[]>;
}

export interface ContentPlanningRelatedDocument {
  id: string;
  title: string;
  updatedAt: string;
  possibleRelevance: number;
  evidence: {
    existedBeforeGap: boolean;
    retrievedByGapAnswers: boolean;
    citedByGapAnswers: boolean;
    changedAfterGap: boolean;
  };
}

export interface ContentPlanningCorpusEvidenceStorePort {
  replaceTopicDocuments(input: {
    workspaceId: string;
    generationId: string;
    topicId: string;
    sourceTopicRevision: number;
    documents: readonly ContentPlanningRelatedDocument[];
  }): Promise<void>;
  invalidateDocument(workspaceId: string, documentId: string): Promise<number>;
}

export type ContentPlanningCorpusEvidenceResult =
  | { state: "ready"; documents: ContentPlanningRelatedDocument[] }
  | { state: "stale"; documents: [] }
  | { state: "unavailable"; documents: [] };

export class ContentPlanningCorpusEvidenceService {
  constructor(private readonly dependencies: {
    search: ContentPlanningCorpusSearchPort;
    store: ContentPlanningCorpusEvidenceStorePort;
  }) {}

  async refresh(input: {
    workspaceId: string;
    generationId: string;
    topicId: string;
    sourceTopicRevision: number;
    embeddingSpaceId: string;
    centroid: readonly number[];
    earliestActiveGapAt: string | null;
    retrievedDocumentIds: readonly string[];
    citedDocumentIds: readonly string[];
  }): Promise<ContentPlanningCorpusEvidenceResult> {
    try {
      const candidates = await this.dependencies.search.findRelatedDocuments({
        workspaceId: input.workspaceId,
        embeddingSpaceId: input.embeddingSpaceId,
        centroid: input.centroid,
        limit: SEARCH_CANDIDATE_LIMIT,
      });
      const documents = selectRelatedDocuments({
        candidates,
        earliestActiveGapAt: input.earliestActiveGapAt,
        retrievedDocumentIds: input.retrievedDocumentIds,
        citedDocumentIds: input.citedDocumentIds,
      });

      await this.dependencies.store.replaceTopicDocuments({
        workspaceId: input.workspaceId,
        generationId: input.generationId,
        topicId: input.topicId,
        sourceTopicRevision: input.sourceTopicRevision,
        documents,
      });
      return { state: "ready", documents };
    } catch (error) {
      if (error instanceof ContentPlanningCorpusRevisionConflictError) {
        return { state: "stale", documents: [] };
      }
      return { state: "unavailable", documents: [] };
    }
  }

  invalidateDeletedDocument(workspaceId: string, documentId: string): Promise<number> {
    return this.dependencies.store.invalidateDocument(workspaceId, documentId);
  }
}

export class ContentPlanningCorpusRevisionConflictError extends Error {
  constructor() {
    super("content_plan_corpus_revision_conflict");
    this.name = "ContentPlanningCorpusRevisionConflictError";
  }
}

const selectRelatedDocuments = (input: {
  candidates: readonly ContentPlanningCorpusCandidate[];
  earliestActiveGapAt: string | null;
  retrievedDocumentIds: readonly string[];
  citedDocumentIds: readonly string[];
}): ContentPlanningRelatedDocument[] => {
  const gapTimestamp = parseTimestamp(input.earliestActiveGapAt);
  const retrieved = new Set(input.retrievedDocumentIds);
  const cited = new Set(input.citedDocumentIds);
  const unique = new Map<string, ContentPlanningCorpusCandidate>();

  for (const candidate of input.candidates) {
    if (!isEligibleCandidate(candidate)) {
      continue;
    }
    const existing = unique.get(candidate.id);
    if (!existing || compareCandidates(candidate, existing) < 0) {
      unique.set(candidate.id, candidate);
    }
  }

  return [...unique.values()]
    .sort(compareCandidates)
    .slice(0, MAX_RELATED_DOCUMENTS)
    .map((candidate) => {
      const createdAt = parseTimestamp(candidate.createdAt);
      const updatedAt = parseTimestamp(candidate.updatedAt);
      return {
        id: candidate.id,
        title: candidate.title,
        updatedAt: candidate.updatedAt,
        possibleRelevance: candidate.possibleRelevance,
        evidence: {
          existedBeforeGap: gapTimestamp !== null && createdAt !== null && createdAt <= gapTimestamp,
          retrievedByGapAnswers: retrieved.has(candidate.id),
          citedByGapAnswers: cited.has(candidate.id),
          changedAfterGap: gapTimestamp !== null && updatedAt !== null && updatedAt > gapTimestamp,
        },
      };
    });
};

const isEligibleCandidate = (candidate: ContentPlanningCorpusCandidate): boolean =>
  candidate.id.length > 0
  && candidate.title.length > 0
  && Number.isFinite(candidate.possibleRelevance)
  && candidate.possibleRelevance >= CONTENT_PLAN_ACTION_POLICY_V1.relatedDocumentRelevanceFloor
  && candidate.possibleRelevance <= 1
  && parseTimestamp(candidate.createdAt) !== null
  && parseTimestamp(candidate.updatedAt) !== null;

const compareCandidates = (
  left: ContentPlanningCorpusCandidate,
  right: ContentPlanningCorpusCandidate,
): number => right.possibleRelevance - left.possibleRelevance || left.id.localeCompare(right.id);

const parseTimestamp = (value: string | null): number | null => {
  if (value === null) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
};
