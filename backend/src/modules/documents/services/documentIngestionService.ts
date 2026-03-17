import type { AuditService } from "../../audit/services/auditService.js";
import { normalizeMarkdown } from "../../retrieval/domain/chunking/chunkingStrategy.js";
import type { StructuredAttributes } from "../../retrieval/domain/structuredAttributes.js";
import { notFound } from "../../../shared/domain/errors.js";

export interface DocumentRecord {
  id: string;
  workspaceId: string;
  title: string;
  sourceContent: string;
  markdownContent: string;
  status: string;
  revision: number;
  failureReason?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChunkRecord {
  id: string;
  documentId: string;
  workspaceId: string;
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
  createAndQueue(input: {
    workspaceId: string;
    title: string;
    sourceContent: string;
    markdownContent: string;
  }): Promise<DocumentRecord>;
  create(input: {
    workspaceId: string;
    title: string;
    sourceContent: string;
    markdownContent: string;
    status: string;
  }): Promise<DocumentRecord>;
  setStatus(input: {
    documentId: string;
    workspaceId: string;
    status: string;
    failureReason?: string | null;
  }): Promise<DocumentRecord>;
  setStatusIfRevisionMatches(input: {
    documentId: string;
    workspaceId: string;
    revision: number;
    status: string;
    failureReason?: string | null;
  }): Promise<DocumentRecord | null>;
  findByIdAndWorkspaceId(documentId: string, workspaceId: string): Promise<DocumentRecord | null>;
  listByWorkspaceId(workspaceId: string): Promise<DocumentRecord[]>;
  update(input: {
    documentId: string;
    workspaceId: string;
    title: string;
    sourceContent: string;
    markdownContent: string;
    status: string;
  }): Promise<DocumentRecord>;
  updateAndQueue(input: {
    documentId: string;
    workspaceId: string;
    title: string;
    sourceContent: string;
    markdownContent: string;
  }): Promise<DocumentRecord>;
  requeue(documentId: string, workspaceId: string): Promise<DocumentRecord>;
  requeueAndQueue(documentId: string, workspaceId: string): Promise<DocumentRecord>;
  deleteByIdAndWorkspaceId(documentId: string, workspaceId: string): Promise<boolean>;
}

export interface ChunkRepositoryPort {
  replaceForDocument(documentId: string, chunks: ChunkRecord[]): Promise<void>;
  publishForDocumentRevision(input: {
    documentId: string;
    workspaceId: string;
    revision: number;
    chunks: ChunkRecord[];
  }): Promise<boolean>;
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
    private readonly auditService: AuditService,
  ) {}

  async ingest(input: { workspaceId: string; title: string; content: string }): Promise<{ documentId: string; status: string }> {
    try {
      const document = await this.documentRepository.createAndQueue({
        workspaceId: input.workspaceId,
        title: input.title,
        sourceContent: input.content,
        markdownContent: normalizeMarkdown(input.content),
      });

      await this.auditService.record({
        workspaceId: input.workspaceId,
        eventType: "document.ingest",
        eventStatus: "success",
        metadata: {
          documentId: document.id,
          revision: document.revision,
          status: document.status,
        },
      });

      return {
        documentId: document.id,
        status: document.status,
      };
    } catch (error) {
      await this.auditService.record({
        workspaceId: input.workspaceId,
        eventType: "document.ingest",
        eventStatus: "failure",
        metadata: {
          reason: error instanceof Error ? error.message : "Failed to queue document processing",
        },
      });
      throw error;
    }
  }

  async update(input: { workspaceId: string; documentId: string; title: string; content: string }): Promise<{ documentId: string; status: string }> {
    await this.getDocument(input.workspaceId, input.documentId);

    try {
      const document = await this.documentRepository.updateAndQueue({
        documentId: input.documentId,
        workspaceId: input.workspaceId,
        title: input.title,
        sourceContent: input.content,
        markdownContent: normalizeMarkdown(input.content),
      });

      await this.auditService.record({
        workspaceId: input.workspaceId,
        eventType: "document.update",
        eventStatus: "success",
        metadata: {
          documentId: document.id,
          revision: document.revision,
          status: document.status,
        },
      });

      return {
        documentId: document.id,
        status: document.status,
      };
    } catch (error) {
      await this.auditService.record({
        workspaceId: input.workspaceId,
        eventType: "document.update",
        eventStatus: "failure",
        metadata: {
          documentId: input.documentId,
          reason: error instanceof Error ? error.message : "Failed to queue document processing",
        },
      });
      throw error;
    }
  }

  async reprocess(input: { workspaceId: string; documentId: string }): Promise<{ documentId: string; status: string }> {
    await this.getDocument(input.workspaceId, input.documentId);

    try {
      const document = await this.documentRepository.requeueAndQueue(input.documentId, input.workspaceId);

      await this.auditService.record({
        workspaceId: input.workspaceId,
        eventType: "document.reprocess",
        eventStatus: "success",
        metadata: {
          documentId: document.id,
          revision: document.revision,
          status: document.status,
        },
      });

      return {
        documentId: document.id,
        status: document.status,
      };
    } catch (error) {
      await this.auditService.record({
        workspaceId: input.workspaceId,
        eventType: "document.reprocess",
        eventStatus: "failure",
        metadata: {
          documentId: input.documentId,
          reason: error instanceof Error ? error.message : "Failed to queue document processing",
        },
      });
      throw error;
    }
  }

  async getDocument(workspaceId: string, documentId: string): Promise<DocumentDetails> {
    const document = await this.documentRepository.findByIdAndWorkspaceId(documentId, workspaceId);
    if (!document) {
      throw notFound("Document not found");
    }

    return this.toDetails(document);
  }

  async listForWorkspace(workspaceId: string): Promise<DocumentSummary[]> {
    const documents = await this.documentRepository.listByWorkspaceId(workspaceId);
    return documents.map((document) => this.toSummary(document));
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
