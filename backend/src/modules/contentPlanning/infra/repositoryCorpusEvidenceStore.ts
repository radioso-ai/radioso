import type { ContentPlanEnrichmentRepositoryPort } from "../contracts/persistence.js";
import {
  ContentPlanningCorpusRevisionConflictError,
  type ContentPlanningCorpusEvidenceStorePort,
  type ContentPlanningRelatedDocument,
} from "../services/corpusEvidenceService.js";

export class RepositoryContentPlanningCorpusEvidenceStore
implements ContentPlanningCorpusEvidenceStorePort {
  constructor(
    private readonly repository: ContentPlanEnrichmentRepositoryPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async replaceTopicDocuments(input: {
    workspaceId: string;
    generationId: string;
    topicId: string;
    sourceTopicRevision: number;
    documents: readonly ContentPlanningRelatedDocument[];
  }): Promise<void> {
    const result = await this.repository.replaceTopicDocuments({
      workspaceId: input.workspaceId,
      generationId: input.generationId,
      topicId: input.topicId,
      sourceTopicRevision: input.sourceTopicRevision,
      documents: input.documents.map((document) => ({
        documentId: document.id,
        similarity: document.possibleRelevance,
        existedBeforeGap: document.evidence.existedBeforeGap,
        retrievedByGapAnswers: document.evidence.retrievedByGapAnswers,
        citedByGapAnswers: document.evidence.citedByGapAnswers,
        changedAfterGap: document.evidence.changedAfterGap,
      })),
    });
    if (!result.applied) {
      throw new ContentPlanningCorpusRevisionConflictError();
    }
  }

  async invalidateDocument(workspaceId: string, documentId: string): Promise<number> {
    const topicIds = await this.repository.invalidateDocumentEvidence({
      workspaceId,
      documentId,
      dirtyAt: this.now(),
    });
    return topicIds.length;
  }
}
