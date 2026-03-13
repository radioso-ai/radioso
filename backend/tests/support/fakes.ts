import { randomUUID } from "node:crypto";

import type {
  AccountRecord,
  AccountRepositoryPort,
  AccountTokenRecord,
  AccountTokenRepositoryPort,
  SessionRecord,
  SessionRepositoryPort,
} from "../../src/modules/auth/services/authService.js";
import type {
  ChunkRecord,
  DocumentRecord,
  DocumentRepositoryPort,
  ChunkRepositoryPort,
} from "../../src/modules/documents/services/documentIngestionService.js";
import type {
  ConversationRecord,
  ConversationRepositoryPort,
} from "../../src/db/repositories/conversationRepository.js";
import type { MessageRecord, MessageRepositoryPort } from "../../src/db/repositories/messageRepository.js";
import type { RetrievalSettingsInput, RetrievalSettingsRecord } from "../../src/modules/settings/domain/retrievalSettings.js";
import type { RetrievalSettingsRepositoryPort } from "../../src/modules/settings/services/retrievalSettingsService.js";
import { AuditService } from "../../src/modules/audit/services/auditService.js";
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

export class InMemoryAccountTokenRepository implements AccountTokenRepositoryPort {
  private readonly items = new Map<string, AccountTokenRecord>();

  async findByAccountId(accountId: string): Promise<AccountTokenRecord | null> {
    return this.items.get(accountId) ?? null;
  }

  async findByTokenHash(tokenHash: string): Promise<AccountTokenRecord | null> {
    return [...this.items.values()].find((item) => item.tokenHash === tokenHash) ?? null;
  }

  async save(params: {
    accountId: string;
    tokenPrefix: string;
    tokenHash: string;
    encryptedToken: string;
  }): Promise<AccountTokenRecord> {
    const existing = this.items.get(params.accountId);
    const record: AccountTokenRecord = {
      accountId: params.accountId,
      tokenPrefix: params.tokenPrefix,
      tokenHash: params.tokenHash,
      encryptedToken: params.encryptedToken,
      createdAt: existing?.createdAt ?? new Date(),
      lastUsedAt: existing?.lastUsedAt ?? null,
    };

    this.items.set(params.accountId, record);
    return record;
  }

  async touch(accountId: string, lastUsedAt: Date): Promise<void> {
    const item = this.items.get(accountId);
    if (item) {
      item.lastUsedAt = lastUsedAt;
    }
  }
}

export class InMemoryRetrievalSettingsRepository implements RetrievalSettingsRepositoryPort {
  private readonly items = new Map<string, RetrievalSettingsRecord>();

  async findByAccountId(accountId: string): Promise<RetrievalSettingsRecord | null> {
    return this.items.get(accountId) ?? null;
  }

  async upsert(accountId: string, input: RetrievalSettingsInput): Promise<RetrievalSettingsRecord> {
    const existing = this.items.get(accountId);
    const record: RetrievalSettingsRecord = {
      accountId,
      queryRewriteEnabled: input.queryRewriteEnabled,
      rerankEnabled: input.rerankEnabled,
      vectorTopK: input.vectorTopK,
      similarityThreshold: input.similarityThreshold,
      rerankTopK: input.rerankTopK,
      createdAt: existing?.createdAt ?? new Date(),
      updatedAt: new Date(),
    };
    this.items.set(accountId, record);
    return record;
  }
}

export class InMemoryDocumentRepository implements DocumentRepositoryPort {
  readonly items = new Map<string, DocumentRecord>();

  async create(input: {
    accountId: string;
    title: string;
    sourceContent: string;
    markdownContent: string;
    status: string;
  }): Promise<DocumentRecord> {
    const record: DocumentRecord = {
      id: randomUUID(),
      accountId: input.accountId,
      title: input.title,
      sourceContent: input.sourceContent,
      markdownContent: input.markdownContent,
      status: input.status,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.items.set(record.id, record);
    return record;
  }

  async listByAccountId(accountId: string): Promise<DocumentRecord[]> {
    return [...this.items.values()]
      .filter((item) => item.accountId === accountId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
}

export class InMemoryChunkRepository implements ChunkRepositoryPort {
  readonly items = new Map<string, ChunkRecord[]>();

  async replaceForDocument(documentId: string, chunks: ChunkRecord[]): Promise<void> {
    this.items.set(documentId, chunks);
  }
}

export class InMemoryConversationRepository implements ConversationRepositoryPort {
  readonly items = new Map<string, ConversationRecord>();

  async create(accountId: string): Promise<ConversationRecord> {
    const record: ConversationRecord = {
      id: randomUUID(),
      accountId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.items.set(record.id, record);
    return record;
  }

  async findByIdAndAccountId(conversationId: string, accountId: string): Promise<ConversationRecord | null> {
    const item = this.items.get(conversationId);
    return item && item.accountId === accountId ? item : null;
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
    accountId: string;
    role: "user" | "assistant" | "system";
    content: string;
  }): Promise<MessageRecord> {
    const record: MessageRecord = {
      id: randomUUID(),
      conversationId: input.conversationId,
      accountId: input.accountId,
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

export const createAuditService = (): AuditService => new AuditService(createLogger("silent"));
