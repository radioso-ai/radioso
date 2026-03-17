import { randomUUID } from "node:crypto";

import type {
  AccountRecord,
  AccountRepositoryPort,
  SessionRecord,
  SessionRepositoryPort,
  WorkspaceTokenRecord,
  WorkspaceTokenRepositoryPort,
} from "../../src/modules/auth/services/authService.js";
import type { WorkspaceRecord, WorkspaceRepositoryPort } from "../../src/db/repositories/workspaceRepository.js";
import type {
  ChunkRecord,
  ChunkRepositoryPort,
  DocumentRecord,
  DocumentRepositoryPort,
} from "../../src/modules/documents/services/documentIngestionService.js";
import type {
  DocumentProcessingJobRecord,
  DocumentProcessingJobRepositoryPort,
} from "../../src/db/repositories/documentProcessingJobRepository.js";
import type {
  ConversationRecord,
  ConversationRepositoryPort,
} from "../../src/db/repositories/conversationRepository.js";
import type {
  AuditEventRecord,
  AuditEventRepositoryPort,
} from "../../src/db/repositories/auditEventRepository.js";
import type { AuditEventInput } from "../../src/modules/audit/services/auditService.js";
import type { MessageRecord, MessageRepositoryPort } from "../../src/db/repositories/messageRepository.js";
import type { RetrievalSettingsInput, RetrievalSettingsRecord } from "../../src/modules/settings/domain/retrievalSettings.js";
import type { RetrievalSettingsRepositoryPort } from "../../src/modules/settings/services/retrievalSettingsService.js";
import { AuditService } from "../../src/modules/audit/services/auditService.js";
import { notFound } from "../../src/shared/domain/errors.js";
import { createLogger } from "../../src/shared/observability/logger.js";

export class InMemoryAccountRepository implements AccountRepositoryPort {
  private readonly items = new Map<string, AccountRecord>();

  async create(params: { email: string; passwordHash: string }): Promise<AccountRecord> {
    const record: AccountRecord = {
      id: randomUUID(),
      email: params.email,
      passwordHash: params.passwordHash,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.items.set(record.id, record);
    return record;
  }

  async findByEmail(email: string): Promise<AccountRecord | null> {
    return [...this.items.values()].find((item) => item.email === email) ?? null;
  }

  async findById(id: string): Promise<AccountRecord | null> {
    return this.items.get(id) ?? null;
  }
}

export class InMemorySessionRepository implements SessionRepositoryPort {
  private readonly items = new Map<string, SessionRecord>();

  async create(params: { accountId: string; sessionTokenHash: string; expiresAt: Date }): Promise<SessionRecord> {
    const record: SessionRecord = {
      id: randomUUID(),
      accountId: params.accountId,
      sessionTokenHash: params.sessionTokenHash,
      createdAt: new Date(),
      expiresAt: params.expiresAt,
      lastSeenAt: new Date(),
      revokedAt: null,
    };

    this.items.set(record.id, record);
    return record;
  }

  async findActiveByTokenHash(sessionTokenHash: string, now: Date): Promise<SessionRecord | null> {
    return (
      [...this.items.values()].find(
        (item) => item.sessionTokenHash === sessionTokenHash && item.expiresAt > now && item.revokedAt === null,
      ) ?? null
    );
  }

  async touch(sessionId: string, lastSeenAt: Date): Promise<void> {
    const item = this.items.get(sessionId);
    if (item) {
      item.lastSeenAt = lastSeenAt;
    }
  }
}

export class InMemoryWorkspaceTokenRepository implements WorkspaceTokenRepositoryPort {
  private readonly items = new Map<string, WorkspaceTokenRecord>();

  async findByWorkspaceId(workspaceId: string): Promise<WorkspaceTokenRecord | null> {
    return [...this.items.values()].find((item) => item.workspaceId === workspaceId) ?? null;
  }

  async findByTokenHash(tokenHash: string): Promise<WorkspaceTokenRecord | null> {
    return [...this.items.values()].find((item) => item.tokenHash === tokenHash) ?? null;
  }

  async save(params: {
    workspaceId: string;
    accountId: string;
    tokenPrefix: string;
    tokenHash: string;
    encryptedToken: string;
  }): Promise<WorkspaceTokenRecord> {
    const existing = [...this.items.values()].find((item) => item.workspaceId === params.workspaceId);
    const record: WorkspaceTokenRecord = {
      id: existing?.id ?? randomUUID(),
      workspaceId: params.workspaceId,
      accountId: params.accountId,
      tokenPrefix: params.tokenPrefix,
      tokenHash: params.tokenHash,
      encryptedToken: params.encryptedToken,
      createdAt: existing?.createdAt ?? new Date(),
      lastUsedAt: existing?.lastUsedAt ?? null,
    };

    this.items.set(record.id, record);
    return record;
  }

  async touch(workspaceId: string, lastUsedAt: Date): Promise<void> {
    const item = [...this.items.values()].find((i) => i.workspaceId === workspaceId);
    if (item) {
      item.lastUsedAt = lastUsedAt;
    }
  }
}

export class InMemoryWorkspaceRepository implements WorkspaceRepositoryPort {
  private readonly items = new Map<string, WorkspaceRecord>();

  async create(accountId: string, name: string): Promise<WorkspaceRecord> {
    const record: WorkspaceRecord = {
      id: randomUUID(),
      accountId,
      name,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.items.set(record.id, record);
    return record;
  }

  async findById(id: string): Promise<WorkspaceRecord | null> {
    return this.items.get(id) ?? null;
  }

  async findByIdAndAccountId(workspaceId: string, accountId: string): Promise<WorkspaceRecord | null> {
    const item = this.items.get(workspaceId);
    return item && item.accountId === accountId ? item : null;
  }

  async listByAccountId(accountId: string): Promise<WorkspaceRecord[]> {
    return [...this.items.values()].filter((w) => w.accountId === accountId);
  }

  async countByAccountId(accountId: string): Promise<number> {
    return [...this.items.values()].filter((w) => w.accountId === accountId).length;
  }

  async deleteById(workspaceId: string): Promise<boolean> {
    return this.items.delete(workspaceId);
  }
}

export class InMemoryRetrievalSettingsRepository implements RetrievalSettingsRepositoryPort {
  private readonly items = new Map<string, RetrievalSettingsRecord>();

  async findByWorkspaceId(workspaceId: string): Promise<RetrievalSettingsRecord | null> {
    return this.items.get(workspaceId) ?? null;
  }

  async upsert(workspaceId: string, input: RetrievalSettingsInput): Promise<RetrievalSettingsRecord> {
    const existing = this.items.get(workspaceId);
    const record: RetrievalSettingsRecord = {
      workspaceId,
      queryRewriteEnabled: input.queryRewriteEnabled,
      rerankEnabled: input.rerankEnabled,
      vectorTopK: input.vectorTopK,
      similarityThreshold: input.similarityThreshold,
      rerankTopK: input.rerankTopK,
      warmthLevel: input.warmthLevel,
      citationDisplayEnabled: input.citationDisplayEnabled,
      chunkingStrategy: input.chunkingStrategy,
      attributeControls: input.attributeControls,
      createdAt: existing?.createdAt ?? new Date(),
      updatedAt: new Date(),
    };
    this.items.set(workspaceId, record);
    return record;
  }
}

export class InMemoryDocumentRepository implements DocumentRepositoryPort {
  readonly items = new Map<string, DocumentRecord>();

  constructor(private jobRepository?: InMemoryDocumentProcessingJobRepository) {}

  setJobRepository(jobRepository: InMemoryDocumentProcessingJobRepository): void {
    this.jobRepository = jobRepository;
  }

  async createAndQueue(input: {
    workspaceId: string;
    title: string;
    sourceContent: string;
    markdownContent: string;
  }): Promise<DocumentRecord> {
    const record: DocumentRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      title: input.title,
      sourceContent: input.sourceContent,
      markdownContent: input.markdownContent,
      status: "queued",
      revision: 1,
      failureReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.jobRepository?.enqueue({
      documentId: record.id,
      workspaceId: record.workspaceId,
      documentRevision: record.revision,
    });
    this.items.set(record.id, record);
    return record;
  }

  async create(input: {
    workspaceId: string;
    title: string;
    sourceContent: string;
    markdownContent: string;
    status: string;
  }): Promise<DocumentRecord> {
    const record: DocumentRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      title: input.title,
      sourceContent: input.sourceContent,
      markdownContent: input.markdownContent,
      status: input.status,
      revision: 1,
      failureReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.items.set(record.id, record);
    return record;
  }

  async listByWorkspaceId(workspaceId: string): Promise<DocumentRecord[]> {
    return [...this.items.values()]
      .filter((item) => item.workspaceId === workspaceId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  async findByIdAndWorkspaceId(documentId: string, workspaceId: string): Promise<DocumentRecord | null> {
    const item = this.items.get(documentId);
    return item && item.workspaceId === workspaceId ? item : null;
  }

  async setStatus(input: {
    documentId: string;
    workspaceId: string;
    status: string;
    failureReason?: string | null;
  }): Promise<DocumentRecord> {
    const existing = this.items.get(input.documentId);
    if (!existing || existing.workspaceId !== input.workspaceId) {
      throw new Error(`Document ${input.documentId} not found`);
    }

    const record: DocumentRecord = {
      ...existing,
      status: input.status,
      failureReason: input.status === "failed" ? (input.failureReason ?? null) : null,
      updatedAt: new Date(),
    };
    this.items.set(record.id, record);
    return record;
  }

  async setStatusIfRevisionMatches(input: {
    documentId: string;
    workspaceId: string;
    revision: number;
    status: string;
    failureReason?: string | null;
  }): Promise<DocumentRecord | null> {
    const existing = this.items.get(input.documentId);
    if (!existing || existing.workspaceId !== input.workspaceId || existing.revision !== input.revision) {
      return null;
    }

    const record: DocumentRecord = {
      ...existing,
      status: input.status,
      failureReason: input.status === "failed" ? (input.failureReason ?? null) : null,
      updatedAt: new Date(),
    };
    this.items.set(record.id, record);
    return record;
  }

  async update(input: {
    documentId: string;
    workspaceId: string;
    title: string;
    sourceContent: string;
    markdownContent: string;
    status: string;
  }): Promise<DocumentRecord> {
    const existing = this.items.get(input.documentId);
    if (!existing || existing.workspaceId !== input.workspaceId) {
      throw new Error(`Document ${input.documentId} not found`);
    }

    const record: DocumentRecord = {
      ...existing,
      title: input.title,
      sourceContent: input.sourceContent,
      markdownContent: input.markdownContent,
      status: input.status,
      revision: existing.revision + 1,
      failureReason: null,
      updatedAt: new Date(),
    };
    this.items.set(record.id, record);
    return record;
  }

  async updateAndQueue(input: {
    documentId: string;
    workspaceId: string;
    title: string;
    sourceContent: string;
    markdownContent: string;
  }): Promise<DocumentRecord> {
    const existing = this.items.get(input.documentId);
    if (!existing || existing.workspaceId !== input.workspaceId) {
      throw notFound("Document not found");
    }

    const record: DocumentRecord = {
      ...existing,
      title: input.title,
      sourceContent: input.sourceContent,
      markdownContent: input.markdownContent,
      status: "queued",
      revision: existing.revision + 1,
      failureReason: null,
      updatedAt: new Date(),
    };

    await this.jobRepository?.enqueue({
      documentId: record.id,
      workspaceId: record.workspaceId,
      documentRevision: record.revision,
    });
    this.items.set(record.id, record);
    return record;
  }

  async requeue(documentId: string, workspaceId: string): Promise<DocumentRecord> {
    const existing = this.items.get(documentId);
    if (!existing || existing.workspaceId !== workspaceId) {
      throw new Error(`Document ${documentId} not found`);
    }

    const record: DocumentRecord = {
      ...existing,
      status: "queued",
      revision: existing.revision + 1,
      failureReason: null,
      updatedAt: new Date(),
    };
    this.items.set(record.id, record);
    return record;
  }

  async requeueAndQueue(documentId: string, workspaceId: string): Promise<DocumentRecord> {
    const existing = this.items.get(documentId);
    if (!existing || existing.workspaceId !== workspaceId) {
      throw notFound("Document not found");
    }

    const record: DocumentRecord = {
      ...existing,
      status: "queued",
      revision: existing.revision + 1,
      failureReason: null,
      updatedAt: new Date(),
    };

    await this.jobRepository?.enqueue({
      documentId: record.id,
      workspaceId: record.workspaceId,
      documentRevision: record.revision,
    });
    this.items.set(record.id, record);
    return record;
  }

  async deleteByIdAndWorkspaceId(documentId: string, workspaceId: string): Promise<boolean> {
    const existing = this.items.get(documentId);
    if (!existing || existing.workspaceId !== workspaceId) {
      return false;
    }

    this.items.delete(documentId);
    return true;
  }
}

export class InMemoryChunkRepository implements ChunkRepositoryPort {
  readonly items = new Map<string, ChunkRecord[]>();

  constructor(private documentRepository?: InMemoryDocumentRepository) {}

  setDocumentRepository(documentRepository: InMemoryDocumentRepository): void {
    this.documentRepository = documentRepository;
  }

  async replaceForDocument(documentId: string, chunks: ChunkRecord[]): Promise<void> {
    this.items.set(documentId, chunks);
  }

  async publishForDocumentRevision(input: {
    documentId: string;
    workspaceId: string;
    revision: number;
    chunks: ChunkRecord[];
  }): Promise<boolean> {
    if (this.documentRepository) {
      const document = this.documentRepository.items.get(input.documentId);
      if (!document || document.workspaceId !== input.workspaceId || document.revision !== input.revision) {
        return false;
      }

      this.documentRepository.items.set(input.documentId, {
        ...document,
        status: "ready",
        failureReason: null,
        updatedAt: new Date(),
      });
    }

    this.items.set(input.documentId, input.chunks);
    return true;
  }
}

export class InMemoryDocumentProcessingJobRepository implements DocumentProcessingJobRepositoryPort {
  readonly items = new Map<string, DocumentProcessingJobRecord>();

  constructor(private documentRepository?: InMemoryDocumentRepository) {}

  setDocumentRepository(documentRepository: InMemoryDocumentRepository): void {
    this.documentRepository = documentRepository;
  }

  async enqueue(input: { documentId: string; workspaceId: string; documentRevision: number }): Promise<DocumentProcessingJobRecord> {
    const record: DocumentProcessingJobRecord = {
      id: randomUUID(),
      documentId: input.documentId,
      workspaceId: input.workspaceId,
      documentRevision: input.documentRevision,
      status: "queued",
      attemptCount: 0,
      lastError: null,
      availableAt: new Date(),
      claimedAt: null,
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.items.set(record.id, record);
    return record;
  }

  async claimNext(now: Date = new Date()): Promise<DocumentProcessingJobRecord | null> {
    const next = [...this.items.values()]
      .filter((item) => item.status === "queued" && item.availableAt <= now)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())[0];

    if (!next) {
      return null;
    }

    const claimed: DocumentProcessingJobRecord = {
      ...next,
      status: "processing",
      attemptCount: next.attemptCount + 1,
      claimedAt: now,
      updatedAt: now,
    };
    this.items.set(claimed.id, claimed);
    return claimed;
  }

  async listProcessingJobs(): Promise<DocumentProcessingJobRecord[]> {
    return [...this.items.values()]
      .filter((item) => item.status === "processing")
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  }

  async markCompleted(jobId: string): Promise<void> {
    this.update(jobId, {
      status: "completed",
      completedAt: new Date(),
    });
  }

  async markSkipped(jobId: string, reason: string): Promise<void> {
    this.update(jobId, {
      status: "skipped",
      lastError: reason,
      completedAt: new Date(),
    });
  }

  async markFailed(jobId: string, errorMessage: string): Promise<void> {
    this.update(jobId, {
      status: "failed",
      lastError: errorMessage,
      completedAt: new Date(),
    });
  }

  async markFailedIfDocumentMatches(input: {
    jobId: string;
    documentId: string;
    workspaceId: string;
    revision: number;
    errorMessage: string;
  }): Promise<boolean> {
    const documentRepository = this.documentRepository;
    const document = documentRepository?.items.get(input.documentId);
    const existingJob = this.items.get(input.jobId);
    if (!documentRepository || !existingJob || !document || document.workspaceId !== input.workspaceId || document.revision !== input.revision) {
      return false;
    }

    documentRepository.items.set(input.documentId, {
      ...document,
      status: "failed",
      failureReason: input.errorMessage,
      updatedAt: new Date(),
    });

    this.update(input.jobId, {
      status: "failed",
      lastError: input.errorMessage,
      completedAt: new Date(),
    });

    return true;
  }

  async reschedule(jobId: string, nextAttemptAt: Date, errorMessage: string): Promise<void> {
    this.update(jobId, {
      status: "queued",
      lastError: errorMessage,
      availableAt: nextAttemptAt,
      claimedAt: null,
    });
  }

  private update(jobId: string, partial: Partial<DocumentProcessingJobRecord>): void {
    const existing = this.items.get(jobId);
    if (!existing) {
      return;
    }

    this.items.set(jobId, {
      ...existing,
      ...partial,
      updatedAt: new Date(),
    });
  }
}

export class InMemoryConversationRepository implements ConversationRepositoryPort {
  readonly items = new Map<string, ConversationRecord>();

  async create(workspaceId: string): Promise<ConversationRecord> {
    const record: ConversationRecord = {
      id: randomUUID(),
      workspaceId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.items.set(record.id, record);
    return record;
  }

  async findByIdAndWorkspaceId(conversationId: string, workspaceId: string): Promise<ConversationRecord | null> {
    const item = this.items.get(conversationId);
    return item && item.workspaceId === workspaceId ? item : null;
  }

  async listByWorkspaceId(workspaceId: string): Promise<ConversationRecord[]> {
    return [...this.items.values()]
      .filter((item) => item.workspaceId === workspaceId)
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
  }

  async touch(conversationId: string): Promise<void> {
    const item = this.items.get(conversationId);
    if (item) {
      item.updatedAt = new Date();
    }
  }
}

export class InMemoryMessageRepository implements MessageRepositoryPort {
  readonly items = new Map<string, MessageRecord[]>();

  async listByConversationId(conversationId: string): Promise<MessageRecord[]> {
    return [...(this.items.get(conversationId) ?? [])];
  }

  async create(input: {
    conversationId: string;
    workspaceId: string;
    role: "user" | "assistant" | "system";
    content: string;
  }): Promise<MessageRecord> {
    const record: MessageRecord = {
      id: randomUUID(),
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      role: input.role,
      content: input.content,
      createdAt: new Date(),
    };
    const items = this.items.get(input.conversationId) ?? [];
    items.push(record);
    this.items.set(input.conversationId, items);
    return record;
  }
}

export class InMemoryAuditEventRepository implements AuditEventRepositoryPort {
  readonly items: AuditEventRecord[] = [];

  async create(input: {
    accountId?: string | null;
    workspaceId?: string | null;
    eventType: string;
    eventStatus: string;
    metadata?: Record<string, unknown>;
  }): Promise<AuditEventRecord> {
    const record: AuditEventRecord = {
      id: randomUUID(),
      accountId: input.accountId ?? null,
      workspaceId: input.workspaceId ?? null,
      eventType: input.eventType,
      eventStatus: input.eventStatus,
      metadata: input.metadata ?? {},
      createdAt: new Date(),
    };
    this.items.push(record);
    return record;
  }

  async listChatAnswerEventsByConversationId(workspaceId: string, conversationId: string): Promise<AuditEventRecord[]> {
    return this.items.filter((event) => {
      return (
        event.workspaceId === workspaceId &&
        event.eventType === "chat.answer" &&
        event.metadata.conversationId === conversationId
      );
    });
  }
}

export class InMemoryAuditService extends AuditService {
  readonly events: AuditEventInput[] = [];

  async record(event: AuditEventInput): Promise<void> {
    this.events.push(event);
    await super.record(event);
  }
}

export const createAuditService = (
  repository: AuditEventRepositoryPort = new InMemoryAuditEventRepository(),
): InMemoryAuditService => new InMemoryAuditService(createLogger("silent"), repository);
