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
import type {
  AccountDailyUsageSummaryRecord,
  AccountDailyUsageSummaryRepositoryPort,
  AccountMonthlyUsageSummaryRecord,
} from "../../src/db/repositories/accountDailyUsageSummaryRepository.js";
import type {
  UsageEventInsertInput,
  UsageEventRecord,
  UsageEventRepositoryPort,
} from "../../src/db/repositories/usageEventRepository.js";
import type { RetrievalSettingsInput, RetrievalSettingsRecord } from "../../src/modules/settings/domain/retrievalSettings.js";
import type { RetrievalSettingsRepositoryPort } from "../../src/modules/settings/services/retrievalSettingsService.js";
import { AuditService } from "../../src/modules/audit/services/auditService.js";
import { notFound } from "../../src/shared/domain/errors.js";
import { createLogger } from "../../src/shared/observability/logger.js";

interface InMemoryConnectorConfigRecord {
  id: string;
  workspaceId: string;
  connectorId: string;
  enabled: boolean;
  configData: Record<string, string>;
  errorStatus: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface InMemoryConnectorContactRecord {
  id: string;
  waId: string;
  profileName: string | null;
  workspaceId: string;
  conversationId: string;
  firstSeenAt: Date;
  lastMessageAt: Date;
}

interface InMemoryConnectorMessageLogRecord {
  id: string;
  wamid: string;
  direction: "inbound" | "outbound";
  workspaceId: string;
  waId: string;
  messageType: string;
  payload: Record<string, unknown>;
  status: "received" | "processing" | "replied" | "failed";
  errorDetails: string | null;
  createdAt: Date;
}

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

  async updateName(workspaceId: string, name: string): Promise<WorkspaceRecord> {
    const item = this.items.get(workspaceId);
    if (!item) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }
    const updated = { ...item, name, updatedAt: new Date() };
    this.items.set(workspaceId, updated);
    return updated;
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
      customInstruction: input.customInstruction,
      createdAt: existing?.createdAt ?? new Date(),
      updatedAt: new Date(),
    };
    this.items.set(workspaceId, record);
    return record;
  }
}

export class InMemoryConnectorDatabase {
  readonly configs = new Map<string, InMemoryConnectorConfigRecord>();
  readonly contacts = new Map<string, InMemoryConnectorContactRecord>();
  readonly messageLogs = new Map<string, InMemoryConnectorMessageLogRecord>();

  async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
    const sql = text.replace(/\s+/g, " ").trim();

    if (sql.startsWith("SELECT connector_id, enabled, error_status FROM connector_configs WHERE workspace_id = $1")) {
      const [workspaceId] = params as [string];
      return [...this.configs.values()]
        .filter((config) => config.workspaceId === workspaceId)
        .map((config) => ({
          connector_id: config.connectorId,
          enabled: config.enabled,
          error_status: config.errorStatus,
        }) as T);
    }

    if (sql.startsWith("SELECT enabled, config_data, error_status FROM connector_configs WHERE workspace_id = $1 AND connector_id = $2")) {
      const [workspaceId, connectorId] = params as [string, string];
      const config = this.configs.get(this.key(workspaceId, connectorId));
      return config
        ? [
            {
              enabled: config.enabled,
              config_data: config.configData,
              error_status: config.errorStatus,
            } as T,
          ]
        : [];
    }

    if (sql.startsWith("SELECT enabled, config_data FROM connector_configs WHERE workspace_id = $1 AND connector_id = $2")) {
      const [workspaceId, connectorId] = params as [string, string];
      const config = this.configs.get(this.key(workspaceId, connectorId));
      return config
        ? [
            {
              enabled: config.enabled,
              config_data: config.configData,
            } as T,
          ]
        : [];
    }

    if (sql.startsWith("SELECT config_data FROM connector_configs WHERE workspace_id = $1 AND connector_id = $2")) {
      const [workspaceId, connectorId] = params as [string, string];
      const config = this.configs.get(this.key(workspaceId, connectorId));
      return config ? [{ config_data: config.configData } as T] : [];
    }

    if (sql.startsWith("SELECT workspace_id FROM connector_configs")) {
      const [connectorId, workspaceId, fieldKey, fieldValue] = params as [string, string, string, string];
      return [...this.configs.values()]
        .filter(
          (config) =>
            config.connectorId === connectorId &&
            config.enabled &&
            config.workspaceId !== workspaceId &&
            config.configData[fieldKey] === fieldValue,
        )
        .map((config) => ({ workspace_id: config.workspaceId }) as T);
    }

    if (sql.startsWith("INSERT INTO connector_configs")) {
      const [workspaceId, connectorId, rawConfig] = params as [string, string, string];
      const key = this.key(workspaceId, connectorId);
      const existing = this.configs.get(key);
      const configData =
        typeof rawConfig === "string" ? (JSON.parse(rawConfig) as Record<string, string>) : (rawConfig as Record<string, string>);
      this.configs.set(key, {
        id: existing?.id ?? randomUUID(),
        workspaceId,
        connectorId,
        enabled: existing?.enabled ?? false,
        configData,
        errorStatus: null,
        createdAt: existing?.createdAt ?? new Date(),
        updatedAt: new Date(),
      });
      return [];
    }

    if (sql.startsWith("UPDATE connector_configs SET enabled = true")) {
      const [workspaceId, connectorId] = params as [string, string];
      const config = this.configs.get(this.key(workspaceId, connectorId));
      if (config) {
        config.enabled = true;
        config.errorStatus = null;
        config.updatedAt = new Date();
      }
      return [];
    }

    if (sql.startsWith("UPDATE connector_configs SET enabled = false")) {
      const [workspaceId, connectorId] = params as [string, string];
      const config = this.configs.get(this.key(workspaceId, connectorId));
      if (config) {
        config.enabled = false;
        config.updatedAt = new Date();
      }
      return [];
    }

    if (sql.startsWith("UPDATE connector_configs SET error_status = $3")) {
      const [workspaceId, connectorId, errorStatus] = params as [string, string, string | null];
      const config = this.configs.get(this.key(workspaceId, connectorId));
      if (config) {
        config.errorStatus = errorStatus;
        config.updatedAt = new Date();
      }
      return [];
    }

    if (sql.startsWith("SELECT wamid FROM connector_whatsapp_message_log WHERE wamid = $1")) {
      const [wamid] = params as [string];
      const record = this.messageLogs.get(wamid);
      return record ? [{ wamid: record.wamid } as T] : [];
    }

    if (
      sql.startsWith(
        "SELECT id, wamid, direction, workspace_id, wa_id, message_type, payload, status, error_details, created_at FROM connector_whatsapp_message_log WHERE wamid = $1",
      )
    ) {
      const [wamid] = params as [string];
      const record = this.messageLogs.get(wamid);
      return record
        ? [
            {
              id: record.id,
              wamid: record.wamid,
              direction: record.direction,
              workspace_id: record.workspaceId,
              wa_id: record.waId,
              message_type: record.messageType,
              payload: record.payload,
              status: record.status,
              error_details: record.errorDetails,
              created_at: record.createdAt,
            } as T,
          ]
        : [];
    }

    if (
      sql.startsWith(
        "SELECT id, wamid, direction, workspace_id, wa_id, message_type, payload, status, error_details, created_at FROM connector_whatsapp_message_log WHERE direction = 'inbound' AND status IN ('received', 'processing') ORDER BY created_at ASC",
      )
    ) {
      return [...this.messageLogs.values()]
        .filter((record) => record.direction === "inbound" && (record.status === "received" || record.status === "processing"))
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
        .map((record) => ({
          id: record.id,
          wamid: record.wamid,
          direction: record.direction,
          workspace_id: record.workspaceId,
          wa_id: record.waId,
          message_type: record.messageType,
          payload: record.payload,
          status: record.status,
          error_details: record.errorDetails,
          created_at: record.createdAt,
        }) as T);
    }

    if (
      sql.startsWith(
        "INSERT INTO connector_whatsapp_message_log ( id, wamid, direction, workspace_id, wa_id, message_type, payload, status, error_details ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, wamid, direction, workspace_id, wa_id, message_type, payload, status, error_details, created_at",
      )
    ) {
      const [id, wamid, direction, workspaceId, waId, messageType, rawPayload, status, errorDetails] = params as [
        string,
        string,
        "inbound" | "outbound",
        string,
        string,
        string,
        string | Record<string, unknown>,
        InMemoryConnectorMessageLogRecord["status"],
        string | null,
      ];
      const payload =
        typeof rawPayload === "string"
          ? (JSON.parse(rawPayload) as Record<string, unknown>)
          : rawPayload;
      const record: InMemoryConnectorMessageLogRecord = {
        id,
        wamid,
        direction,
        workspaceId,
        waId,
        messageType,
        payload,
        status,
        errorDetails,
        createdAt: new Date(),
      };
      this.messageLogs.set(wamid, record);
      return [
        {
          id: record.id,
          wamid: record.wamid,
          direction: record.direction,
          workspace_id: record.workspaceId,
          wa_id: record.waId,
          message_type: record.messageType,
          payload: record.payload,
          status: record.status,
          error_details: record.errorDetails,
          created_at: record.createdAt,
        } as T,
      ];
    }

    if (sql.startsWith("INSERT INTO connector_whatsapp_message_log")) {
      const [wamid, direction, workspaceId, waId, messageType, rawPayload, status, errorDetails] = params as [
        string,
        "inbound" | "outbound",
        string,
        string,
        string,
        string | Record<string, unknown>,
        InMemoryConnectorMessageLogRecord["status"],
        string | null,
      ];
      const payload =
        typeof rawPayload === "string"
          ? (JSON.parse(rawPayload) as Record<string, unknown>)
          : rawPayload;
      this.messageLogs.set(wamid, {
        id: randomUUID(),
        wamid,
        direction,
        workspaceId,
        waId,
        messageType,
        payload,
        status,
        errorDetails,
        createdAt: new Date(),
      });
      return [];
    }

    if (sql.startsWith("UPDATE connector_whatsapp_message_log SET status = $2, error_details = $3 WHERE wamid = $1")) {
      const [wamid, status, errorDetails] = params as [
        string,
        InMemoryConnectorMessageLogRecord["status"],
        string | null,
      ];
      const record = this.messageLogs.get(wamid);
      if (record) {
        record.status = status;
        record.errorDetails = errorDetails;
      }
      return [];
    }

    if (sql.startsWith("DELETE FROM connector_whatsapp_message_log WHERE created_at < $1")) {
      const [cutoff] = params as [Date];
      for (const [wamid, record] of this.messageLogs.entries()) {
        if (record.createdAt < cutoff) {
          this.messageLogs.delete(wamid);
        }
      }
      return [];
    }

    if (sql.startsWith("SELECT wa_id, profile_name, workspace_id, conversation_id, first_seen_at, last_message_at FROM connector_whatsapp_contacts")) {
      const [workspaceId, waId] = params as [string, string];
      const record = this.findContact(workspaceId, waId);
      return record
        ? [
            {
              wa_id: record.waId,
              profile_name: record.profileName,
              workspace_id: record.workspaceId,
              conversation_id: record.conversationId,
              first_seen_at: record.firstSeenAt,
              last_message_at: record.lastMessageAt,
            } as T,
          ]
        : [];
    }

    if (
      sql.startsWith(
        "SELECT id, wa_id, profile_name, workspace_id, conversation_id, first_seen_at, last_message_at FROM connector_whatsapp_contacts WHERE workspace_id = $1 AND wa_id = $2",
      )
    ) {
      const [workspaceId, waId] = params as [string, string];
      const record = this.findContact(workspaceId, waId);
      return record
        ? [
            {
              id: record.id,
              wa_id: record.waId,
              profile_name: record.profileName,
              workspace_id: record.workspaceId,
              conversation_id: record.conversationId,
              first_seen_at: record.firstSeenAt,
              last_message_at: record.lastMessageAt,
            } as T,
          ]
        : [];
    }

    if (
      sql.startsWith(
        "INSERT INTO connector_whatsapp_contacts ( id, wa_id, profile_name, workspace_id, conversation_id, last_message_at ) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (workspace_id, wa_id) DO UPDATE SET profile_name = EXCLUDED.profile_name, conversation_id = EXCLUDED.conversation_id, last_message_at = EXCLUDED.last_message_at RETURNING id, wa_id, profile_name, workspace_id, conversation_id, first_seen_at, last_message_at",
      )
    ) {
      const [id, waId, profileName, workspaceId, conversationId, lastMessageAt] = params as [
        string,
        string,
        string | null,
        string,
        string,
        Date,
      ];
      const key = this.contactKey(workspaceId, waId);
      const existing = this.contacts.get(key);
      const record: InMemoryConnectorContactRecord = {
        id: existing?.id ?? id,
        waId,
        profileName,
        workspaceId,
        conversationId,
        firstSeenAt: existing?.firstSeenAt ?? lastMessageAt,
        lastMessageAt,
      };
      this.contacts.set(key, record);
      return [
        {
          id: record.id,
          wa_id: record.waId,
          profile_name: record.profileName,
          workspace_id: record.workspaceId,
          conversation_id: record.conversationId,
          first_seen_at: record.firstSeenAt,
          last_message_at: record.lastMessageAt,
        } as T,
      ];
    }

    if (sql.startsWith("INSERT INTO connector_whatsapp_contacts")) {
      const [waId, profileName, workspaceId, conversationId, lastMessageAt] = params as [
        string,
        string | null,
        string,
        string,
        Date,
      ];
      const key = this.contactKey(workspaceId, waId);
      const existing = this.contacts.get(key);
      this.contacts.set(key, {
        id: existing?.id ?? randomUUID(),
        waId,
        profileName,
        workspaceId,
        conversationId,
        firstSeenAt: existing?.firstSeenAt ?? lastMessageAt,
        lastMessageAt,
      });
      return [];
    }

    return [];
  }

  insertMessageLog(input: {
    wamid: string;
    workspaceId: string;
    waId: string;
    messageType: string;
    payload: Record<string, unknown>;
    status: InMemoryConnectorMessageLogRecord["status"];
    direction?: InMemoryConnectorMessageLogRecord["direction"];
    errorDetails?: string | null;
    createdAt?: Date;
  }): void {
    this.messageLogs.set(input.wamid, {
      id: randomUUID(),
      wamid: input.wamid,
      direction: input.direction ?? "inbound",
      workspaceId: input.workspaceId,
      waId: input.waId,
      messageType: input.messageType,
      payload: input.payload,
      status: input.status,
      errorDetails: input.errorDetails ?? null,
      createdAt: input.createdAt ?? new Date(),
    });
  }

  async insertInboundMessageLog(input: {
    wamid: string;
    workspaceId: string;
    waId: string;
    messageType: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    this.insertMessageLog({
      ...input,
      direction: "inbound",
      status: "received",
    });
  }

  insertContact(input: {
    workspaceId: string;
    waId: string;
    profileName: string | null;
    conversationId: string;
    lastMessageAt: Date;
  }): void {
    this.contacts.set(this.contactKey(input.workspaceId, input.waId), {
      id: randomUUID(),
      waId: input.waId,
      profileName: input.profileName,
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      firstSeenAt: input.lastMessageAt,
      lastMessageAt: input.lastMessageAt,
    });
  }

  findContact(workspaceId: string, waId: string): InMemoryConnectorContactRecord | undefined {
    return this.contacts.get(this.contactKey(workspaceId, waId));
  }

  private key(workspaceId: string, connectorId: string): string {
    return `${workspaceId}:${connectorId}`;
  }

  private contactKey(workspaceId: string, waId: string): string {
    return `${workspaceId}:${waId}`;
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
    metadata?: Record<string, unknown>;
  }): Promise<DocumentRecord> {
    const record: DocumentRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      title: input.title,
      sourceContent: input.sourceContent,
      markdownContent: input.markdownContent,
      metadata: input.metadata ?? {},
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
    metadata?: Record<string, unknown>;
  }): Promise<DocumentRecord> {
    const record: DocumentRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      title: input.title,
      sourceContent: input.sourceContent,
      markdownContent: input.markdownContent,
      metadata: input.metadata ?? {},
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
      metadata: existing.metadata ?? {},
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
      metadata: existing.metadata ?? {},
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
    metadata?: Record<string, unknown>;
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
      metadata: input.metadata ?? existing.metadata ?? {},
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
    metadata?: Record<string, unknown>;
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
      metadata: input.metadata ?? existing.metadata ?? {},
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
      metadata: existing.metadata ?? {},
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
      metadata: existing.metadata ?? {},
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

  async create(workspaceId: string, sourceChannel: string | null = null): Promise<ConversationRecord> {
    const record: ConversationRecord = {
      id: randomUUID(),
      workspaceId,
      sourceChannel,
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

const toUtcDate = (value: Date): string => value.toISOString().slice(0, 10);
const toUtcMonth = (value: string): string => value.slice(0, 7);

export class InMemoryAccountDailyUsageSummaryRepository implements AccountDailyUsageSummaryRepositoryPort {
  readonly items = new Map<string, AccountDailyUsageSummaryRecord>();

  async findByAccountIdAndDate(accountId: string, usageDate: string): Promise<AccountDailyUsageSummaryRecord | null> {
    return this.items.get(`${accountId}:${usageDate}`) ?? null;
  }

  async listRecentByAccountId(accountId: string, days: number): Promise<AccountDailyUsageSummaryRecord[]> {
    return [...this.items.values()]
      .filter((row) => row.accountId === accountId)
      .sort((left, right) => right.usageDate.localeCompare(left.usageDate))
      .slice(0, days);
  }

  async listRecentMonthsByAccountId(accountId: string, months: number): Promise<AccountMonthlyUsageSummaryRecord[]> {
    const grouped = new Map<string, AccountMonthlyUsageSummaryRecord>();

    for (const row of this.items.values()) {
      if (row.accountId !== accountId) {
        continue;
      }

      const month = toUtcMonth(row.usageDate);
      const current = grouped.get(month) ?? {
        month,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        usageEventCount: 0,
        unavailableEventCount: 0,
      };
      current.promptTokens += row.promptTokens;
      current.completionTokens += row.completionTokens;
      current.totalTokens += row.totalTokens;
      current.usageEventCount += row.usageEventCount;
      current.unavailableEventCount += row.unavailableEventCount;
      grouped.set(month, current);
    }

    return [...grouped.values()]
      .sort((left, right) => right.month.localeCompare(left.month))
      .slice(0, months);
  }

  async replaceAllForAccount(input: {
    accountId: string;
    rows: Array<{
      usageDate: string;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      usageEventCount: number;
      unavailableEventCount: number;
    }>;
  }): Promise<void> {
    for (const key of [...this.items.keys()]) {
      if (key.startsWith(`${input.accountId}:`)) {
        this.items.delete(key);
      }
    }

    for (const row of input.rows) {
      this.items.set(`${input.accountId}:${row.usageDate}`, {
        accountId: input.accountId,
        usageDate: row.usageDate,
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
        totalTokens: row.totalTokens,
        usageEventCount: row.usageEventCount,
        unavailableEventCount: row.unavailableEventCount,
        updatedAt: new Date(),
      });
    }
  }
}

export class InMemoryUsageEventRepository implements UsageEventRepositoryPort {
  readonly items: UsageEventRecord[] = [];

  constructor(
    private readonly summaryRepository: InMemoryAccountDailyUsageSummaryRepository = new InMemoryAccountDailyUsageSummaryRepository(),
  ) {}

  async record(input: UsageEventInsertInput): Promise<{ inserted: boolean; record: UsageEventRecord | null }> {
    if (this.items.some((item) => item.operationKey === input.operationKey)) {
      return { inserted: false, record: null };
    }

    const record: UsageEventRecord = {
      id: randomUUID(),
      operationKey: input.operationKey,
      accountId: input.accountId,
      workspaceId: input.workspaceId ?? null,
      conversationId: input.conversationId ?? null,
      userMessageId: input.userMessageId ?? null,
      assistantMessageId: input.assistantMessageId ?? null,
      documentId: input.documentId ?? null,
      processingJobId: input.processingJobId ?? null,
      sourceArea: input.sourceArea,
      operationType: input.operationType,
      model: input.model,
      eventStatus: input.eventStatus,
      usageAvailable: input.usageAvailable,
      promptTokens: input.promptTokens ?? null,
      completionTokens: input.completionTokens ?? null,
      totalTokens: input.totalTokens ?? null,
      metadata: input.metadata ?? {},
      occurredAt: input.occurredAt,
      createdAt: new Date(),
    };
    this.items.push(record);

    const usageDate = toUtcDate(input.occurredAt);
    const existing = await this.summaryRepository.findByAccountIdAndDate(input.accountId, usageDate);
    const next: AccountDailyUsageSummaryRecord = {
      accountId: input.accountId,
      usageDate,
      promptTokens: (existing?.promptTokens ?? 0) + (input.promptTokens ?? 0),
      completionTokens: (existing?.completionTokens ?? 0) + (input.completionTokens ?? 0),
      totalTokens: (existing?.totalTokens ?? 0) + (input.totalTokens ?? 0),
      usageEventCount: (existing?.usageEventCount ?? 0) + 1,
      unavailableEventCount: (existing?.unavailableEventCount ?? 0) + (input.usageAvailable ? 0 : 1),
      updatedAt: new Date(),
    };
    this.summaryRepository.items.set(`${input.accountId}:${usageDate}`, next);

    return { inserted: true, record };
  }

  async listByAssistantMessageIds(assistantMessageIds: string[]): Promise<UsageEventRecord[]> {
    return this.items
      .filter((item) => item.assistantMessageId !== null && assistantMessageIds.includes(item.assistantMessageId))
      .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime());
  }

  async listByAccountId(accountId: string): Promise<UsageEventRecord[]> {
    return this.items
      .filter((item) => item.accountId === accountId)
      .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime());
  }

  async aggregateDailyByAccountId(accountId: string): Promise<Array<{
    usageDate: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    usageEventCount: number;
    unavailableEventCount: number;
  }>> {
    const grouped = new Map<string, {
      usageDate: string;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      usageEventCount: number;
      unavailableEventCount: number;
    }>();

    for (const event of this.items) {
      if (event.accountId !== accountId) {
        continue;
      }

      const usageDate = toUtcDate(event.occurredAt);
      const current = grouped.get(usageDate) ?? {
        usageDate,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        usageEventCount: 0,
        unavailableEventCount: 0,
      };
      current.promptTokens += event.promptTokens ?? 0;
      current.completionTokens += event.completionTokens ?? 0;
      current.totalTokens += event.totalTokens ?? 0;
      current.usageEventCount += 1;
      current.unavailableEventCount += event.usageAvailable ? 0 : 1;
      grouped.set(usageDate, current);
    }

    return [...grouped.values()].sort((left, right) => left.usageDate.localeCompare(right.usageDate));
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
