import { randomUUID } from "node:crypto";

import type { AuditService } from "../../audit/services/auditService.js";
import { chunkMarkdown, normalizeMarkdown } from "../../retrieval/domain/chunkingService.js";
import type { EmbeddingService } from "../../retrieval/services/embeddingService.js";

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
  listByAccountId(accountId: string): Promise<DocumentRecord[]>;
}

export interface ChunkRepositoryPort {
  replaceForDocument(documentId: string, chunks: ChunkRecord[]): Promise<void>;
}

export class DocumentIngestionService {
  constructor(
    private readonly documentRepository: DocumentRepositoryPort,
    private readonly chunkRepository: ChunkRepositoryPort,
    private readonly embeddingService: EmbeddingService,
    private readonly auditService: AuditService,
  ) {}

  async ingest(input: { accountId: string; title: string; content: string }): Promise<{ documentId: string; status: string }> {
    try {
      const markdownContent = normalizeMarkdown(input.content);
      const document = await this.documentRepository.create({
        accountId: input.accountId,
        title: input.title,
        sourceContent: input.content,
        markdownContent,
        status: "ready",
      });

      const chunks = chunkMarkdown(markdownContent);
      const embeddings = await this.embeddingService.embedChunks(chunks.map((chunk) => chunk.content));
      const persistedChunks: ChunkRecord[] = chunks.map((chunk, index) => ({
        id: randomUUID(),
        documentId: document.id,
        accountId: input.accountId,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        embedding: embeddings[index] ?? [],
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
        createdAt: new Date(),
      }));

      await this.chunkRepository.replaceForDocument(document.id, persistedChunks);
      await this.auditService.record({
        accountId: input.accountId,
        eventType: "document.ingest",
        eventStatus: "success",
        metadata: { documentId: document.id },
      });

      return {
        documentId: document.id,
        status: document.status,
      };
    } catch (error) {
      await this.auditService.record({
        accountId: input.accountId,
        eventType: "document.ingest",
        eventStatus: "failure",
      });
      throw error;
    }
  }

  async listForAccount(accountId: string): Promise<Array<{ id: string; title: string; status: string; createdAt: Date }>> {
    const documents = await this.documentRepository.listByAccountId(accountId);

    return documents.map((document) => ({
      id: document.id,
      title: document.title,
      status: document.status,
      createdAt: document.createdAt,
    }));
  }
}
