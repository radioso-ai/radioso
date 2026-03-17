import { randomUUID } from "node:crypto";

import type { AuditService } from "../../audit/services/auditService.js";
import type { DocumentProcessingJobRecord } from "../../../db/repositories/documentProcessingJobRepository.js";
import { normalizeMarkdown, type ChunkingStrategy } from "../../retrieval/domain/chunking/chunkingStrategy.js";
import {
  emptyStructuredAttributes,
  renderStructuredAttributeSummary,
} from "../../retrieval/domain/structuredAttributes.js";
import { normalizeStructuredAttributes } from "../../retrieval/services/attributeNormalizer.js";
import { renderSearchText } from "../../retrieval/services/searchTextRenderer.js";
import { extractRawStructuredAttributes } from "../../retrieval/services/structuredAttributeExtractor.js";
import { deriveChunkSection, deriveDocumentSubject } from "../../retrieval/services/subjectIdentityService.js";
import type { RetrievalSettingsRecord } from "../../settings/domain/retrievalSettings.js";
import type {
  ChunkRecord,
  ChunkRepositoryPort,
  DocumentRepositoryPort,
} from "./documentIngestionService.js";
import { type EmbeddingService } from "../../retrieval/services/embeddingService.js";
import type { ChunkingStrategyId } from "../../retrieval/domain/chunking/chunkingStrategy.js";

export interface RetrievalSettingsReaderPort {
  getForAccount(accountId: string): Promise<RetrievalSettingsRecord>;
}

export interface ChunkingStrategyRegistryPort {
  get(strategyId: ChunkingStrategyId): ChunkingStrategy;
}

export type DocumentProcessingOutcome = "completed" | "stale" | "deleted";

export class DocumentProcessingService {
  constructor(
    private readonly documentRepository: DocumentRepositoryPort,
    private readonly chunkRepository: ChunkRepositoryPort,
    private readonly embeddingService: EmbeddingService,
    private readonly auditService: AuditService,
    private readonly retrievalSettingsService: RetrievalSettingsReaderPort,
    private readonly chunkingStrategyRegistry: ChunkingStrategyRegistryPort,
  ) {}

  async process(job: DocumentProcessingJobRecord): Promise<DocumentProcessingOutcome> {
    const markedProcessing = await this.documentRepository.setStatusIfRevisionMatches({
      documentId: job.documentId,
      accountId: job.accountId,
      revision: job.documentRevision,
      status: "processing",
      failureReason: null,
    });

    if (!markedProcessing) {
      const document = await this.documentRepository.findByIdAndAccountId(job.documentId, job.accountId);
      return document ? "stale" : "deleted";
    }

    const documentSubject = deriveDocumentSubject({
      title: markedProcessing.title,
      content: normalizeMarkdown(markedProcessing.sourceContent),
    });
    const settings = await this.retrievalSettingsService.getForAccount(job.accountId);
    const chunkingStrategy = this.chunkingStrategyRegistry.get(settings.chunkingStrategy);
    const chunks = await chunkingStrategy.chunk({
      title: markedProcessing.title,
      content: markedProcessing.markdownContent,
    });
    const enrichedChunks = chunks.map((chunk) => {
      const structuredAttributes = normalizeStructuredAttributes(extractRawStructuredAttributes(chunk.content));
      const attributeText = renderStructuredAttributeSummary(structuredAttributes);
      const searchText = renderSearchText({
        title: markedProcessing.title,
        subjectLabel: documentSubject,
        sectionPath: deriveChunkSection(chunk.content),
        attributeText,
        content: chunk.content,
      });

      return {
        ...chunk,
        structuredAttributes,
        searchText,
      };
    });
    const embeddings = await this.embeddingService.embedChunks(
      enrichedChunks.map((chunk) => chunk.searchText),
    );
    const persistedChunks: ChunkRecord[] = enrichedChunks.map((chunk, index) => ({
      id: randomUUID(),
      documentId: markedProcessing.id,
      accountId: job.accountId,
      chunkIndex: chunk.chunkIndex,
      content: chunk.content,
      searchText: chunk.searchText,
      structuredAttributes: chunk.structuredAttributes ?? emptyStructuredAttributes(),
      embedding: embeddings[index] ?? [],
      startOffset: chunk.startOffset,
      endOffset: chunk.endOffset,
      createdAt: new Date(),
    }));

    const published = await this.chunkRepository.publishForDocumentRevision({
      documentId: markedProcessing.id,
      accountId: job.accountId,
      revision: job.documentRevision,
      chunks: persistedChunks,
    });

    if (!published) {
      const currentDocument = await this.documentRepository.findByIdAndAccountId(job.documentId, job.accountId);
      return currentDocument ? "stale" : "deleted";
    }

    await this.auditService.record({
      accountId: job.accountId,
      eventType: "document.process",
      eventStatus: "success",
      metadata: {
        documentId: markedProcessing.id,
        revision: job.documentRevision,
      },
    });

    return "completed";
  }
}
