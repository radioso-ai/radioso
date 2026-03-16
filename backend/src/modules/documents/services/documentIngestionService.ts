import { randomUUID } from "node:crypto";

import type { AuditService } from "../../audit/services/auditService.js";
import { normalizeMarkdown, type ChunkingStrategy } from "../../retrieval/domain/chunking/chunkingStrategy.js";
import {
  emptyStructuredAttributes,
  renderStructuredAttributeSummary,
  type StructuredAttributes,
} from "../../retrieval/domain/structuredAttributes.js";
import { normalizeStructuredAttributes } from "../../retrieval/services/attributeNormalizer.js";
import { buildRetrievalText, type EmbeddingService } from "../../retrieval/services/embeddingService.js";
import type { ChunkingStrategyId } from "../../retrieval/domain/chunking/chunkingStrategy.js";
import { renderSearchText } from "../../retrieval/services/searchTextRenderer.js";
import { extractRawStructuredAttributes } from "../../retrieval/services/structuredAttributeExtractor.js";
import { deriveChunkSection, deriveDocumentSubject } from "../../retrieval/services/subjectIdentityService.js";
import type { RetrievalSettingsRecord } from "../../settings/domain/retrievalSettings.js";
import { notFound } from "../../../shared/domain/errors.js";

export interface DocumentRecord {
  id: string;
  accountId: string;
  title: string;
  sourceContent: string;
  markdownContent: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChunkRecord {
  id: string;
  documentId: string;
  accountId: string;
  chunkIndex: number;
  content: string;
  searchText?: string | null;
  structuredAttributes?: StructuredAttributes | null;
  embedding: number[];
  startOffset: number;
  endOffset: number;
  createdAt: Date;
}

export interface DocumentRepositoryPort {
  create(input: {
    accountId: string;
    title: string;
    sourceContent: string;
    markdownContent: string;
    status: string;
  }): Promise<DocumentRecord>;
  setStatus(input: {
    documentId: string;
    accountId: string;
    status: string;
    failureReason?: string | null;
  }): Promise<DocumentRecord>;
  findByIdAndAccountId(documentId: string, accountId: string): Promise<DocumentRecord | null>;
  listByAccountId(accountId: string): Promise<DocumentRecord[]>;
  update(input: {
    documentId: string;
    accountId: string;
    title: string;
    sourceContent: string;
    markdownContent: string;
    status: string;
  }): Promise<DocumentRecord>;
  deleteByIdAndAccountId(documentId: string, accountId: string): Promise<boolean>;
}

export interface ChunkRepositoryPort {
  replaceForDocument(documentId: string, chunks: ChunkRecord[]): Promise<void>;
}

export interface RetrievalSettingsReaderPort {
  getForAccount(accountId: string): Promise<RetrievalSettingsRecord>;
}

export interface ChunkingStrategyRegistryPort {
  get(strategyId: ChunkingStrategyId): ChunkingStrategy;
}

export interface DocumentSummary {
  id: string;
  title: string;
  status: string;
  ragStatus: "processed" | "pending";
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentDetails extends DocumentSummary {
  content: string;
}

export class DocumentIngestionService {
  constructor(
    private readonly documentRepository: DocumentRepositoryPort,
    private readonly chunkRepository: ChunkRepositoryPort,
    private readonly embeddingService: EmbeddingService,
    private readonly auditService: AuditService,
    private readonly retrievalSettingsService: RetrievalSettingsReaderPort,
    private readonly chunkingStrategyRegistry: ChunkingStrategyRegistryPort,
  ) {}

  async ingest(input: { accountId: string; title: string; content: string }): Promise<{ documentId: string; status: string }> {
    return this.persistDocument(input);
  }

  async update(input: { accountId: string; documentId: string; title: string; content: string }): Promise<{ documentId: string; status: string }> {
    await this.getDocument(input.accountId, input.documentId);
    return this.persistDocument(input);
  }

  async getDocument(accountId: string, documentId: string): Promise<DocumentDetails> {
    const document = await this.documentRepository.findByIdAndAccountId(documentId, accountId);
    if (!document) {
      throw notFound("Document not found");
    }

    return this.toDetails(document);
  }

  async listForAccount(accountId: string): Promise<DocumentSummary[]> {
    const documents = await this.documentRepository.listByAccountId(accountId);
    return documents.map((document) => this.toSummary(document));
  }

  private async persistDocument(input: {
    accountId: string;
    title: string;
    content: string;
    documentId?: string;
  }): Promise<{ documentId: string; status: string }> {
    let documentId: string | undefined;

    try {
      const markdownContent = normalizeMarkdown(input.content);
      const documentSubject = deriveDocumentSubject({
        title: input.title,
        content: markdownContent,
      });
      const settings = await this.retrievalSettingsService.getForAccount(input.accountId);
      const chunkingStrategy = this.chunkingStrategyRegistry.get(settings.chunkingStrategy);
      const chunks = await chunkingStrategy.chunk({
        title: input.title,
        content: markdownContent,
      });
      const enrichedChunks = chunks.map((chunk) => {
        const structuredAttributes = normalizeStructuredAttributes(extractRawStructuredAttributes(chunk.content));
        const attributeText = renderStructuredAttributeSummary(structuredAttributes);
        const searchText = renderSearchText({
          title: input.title,
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
      const persistedDocumentInput = {
        accountId: input.accountId,
        title: input.title,
        sourceContent: input.content,
        markdownContent,
        status: "pending",
      };
      const document = input.documentId
        ? await this.documentRepository.update({
            documentId: input.documentId,
            ...persistedDocumentInput,
          })
        : await this.documentRepository.create(persistedDocumentInput);
      documentId = document.id;
      const persistedChunks: ChunkRecord[] = enrichedChunks.map((chunk, index) => ({
        id: randomUUID(),
        documentId: document.id,
        accountId: input.accountId,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        searchText: chunk.searchText,
        structuredAttributes: chunk.structuredAttributes ?? emptyStructuredAttributes(),
        embedding: embeddings[index] ?? [],
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
        createdAt: new Date(),
      }));

      await this.chunkRepository.replaceForDocument(document.id, persistedChunks);
      const readyDocument = await this.documentRepository.setStatus({
        documentId: document.id,
        accountId: input.accountId,
        status: "ready",
        failureReason: null,
      });
      await this.auditService.record({
        accountId: input.accountId,
        eventType: input.documentId ? "document.update" : "document.ingest",
        eventStatus: "success",
        metadata: { documentId: document.id },
      });

      return {
        documentId: document.id,
        status: readyDocument.status,
      };
    } catch (error) {
      if (documentId) {
        await this.documentRepository.setStatus({
          documentId,
          accountId: input.accountId,
          status: "failed",
          failureReason: error instanceof Error ? error.message : "Unknown ingestion error",
        });
      }
      await this.auditService.record({
        accountId: input.accountId,
        eventType: input.documentId ? "document.update" : "document.ingest",
        eventStatus: "failure",
      });
      throw error;
    }
  }

  private toSummary(document: DocumentRecord): DocumentSummary {
    return {
      id: document.id,
      title: document.title,
      status: document.status,
      ragStatus: document.status === "ready" ? "processed" : "pending",
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    };
  }

  private toDetails(document: DocumentRecord): DocumentDetails {
    return {
      ...this.toSummary(document),
      content: document.sourceContent,
    };
  }
}
