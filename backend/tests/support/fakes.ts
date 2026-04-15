import { randomUUID } from "node:crypto";

import type {
  AccountMembershipRecord,
  AccountMembershipRepositoryPort,
  AccountMembershipRole,
  AccountMembershipStatus,
  AccountMembershipUserRecord,
} from "../../src/db/repositories/accountMembershipRepository.js";
import type {
  AccountInvitationRecord,
  AccountInvitationRepositoryPort,
  AccountInvitationStatus,
} from "../../src/db/repositories/accountInvitationRepository.js";
import type {
  AccountRecord,
  AccountRepositoryPort,
  SessionRecord,
  SessionRepositoryPort,
  WorkspaceTokenRecord,
  WorkspaceTokenRepositoryPort,
} from "../../src/modules/auth/services/authService.js";
import type { UserRecord, UserRepositoryPort } from "../../src/db/repositories/userRepository.js";
import type { WorkspaceRecord, WorkspaceRepositoryPort } from "../../src/db/repositories/workspaceRepository.js";
import type { AbuseControlEntry, AbuseControlRepositoryPort } from "../../src/db/repositories/abuseControlRepository.js";
import type {
  ChunkRecord,
  ChunkRepositoryPort,
  DocumentCreateInput,
  DocumentDerivedContentUpdateInput,
  DocumentQueueUpdateInput,
  DocumentRecord,
  DocumentRepositoryPort,
  DocumentSummaryRecord,
  DocumentUpdateInput,
} from "../../src/modules/documents/services/documentIngestionService.js";
import type {
  DocumentProcessingJobRecord,
  DocumentProcessingQueueSnapshot,
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
import type {
  ConversationMessageSummary,
  MessageRecord,
  MessageRepositoryPort,
} from "../../src/db/repositories/messageRepository.js";
import type {
  IngestionSettingsInput,
  IngestionSettingsRecord,
} from "../../src/modules/settings/domain/ingestionSettings.js";
import {
  inferMetadataValueType,
  type MetadataFieldSuggestion,
  type MetadataValueType,
  type RetrievalSettingsInput,
  type RetrievalSettingsRecord,
} from "../../src/modules/settings/domain/retrievalSettings.js";
import type { IngestionSettingsRepositoryPort } from "../../src/modules/settings/services/ingestionSettingsService.js";
import type { RetrievalSettingsRepositoryPort } from "../../src/modules/settings/services/retrievalSettingsService.js";
import { AuditService } from "../../src/modules/audit/services/auditService.js";
import type {
  DocumentStorageDeleteInput,
  DocumentStoragePort,
  DocumentStorageReadInput,
  DocumentStorageUploadInput,
} from "../../src/modules/documents/infra/gcsDocumentStorage.js";
import type {
  EvalCaseCreateInput,
  EvalCaseRecord,
  EvalDatasetRecord,
  EvalDatasetSummary,
  EvalRunRecord,
} from "../../src/modules/evals/domain/evalTypes.js";
import type { EvalRepositoryPort } from "../../src/modules/evals/services/evalLabService.js";
import { conflict, notFound } from "../../src/shared/domain/errors.js";
import { decodeCursorWithKeys, encodeCursor } from "../../src/shared/domain/cursorPagination.js";
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

  async create(params: { name: string; email: string; passwordHash: string }): Promise<AccountRecord> {
    const record: AccountRecord = {
      id: randomUUID(),
      name: params.name,
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

  async updateName(id: string, name: string): Promise<AccountRecord> {
    const existing = this.items.get(id);
    if (!existing) {
      throw notFound("Account not found");
    }

    const updated: AccountRecord = {
      ...existing,
      name,
      updatedAt: new Date(),
    };
    this.items.set(id, updated);
    return updated;
  }

  async deleteById(id: string): Promise<boolean> {
    return this.items.delete(id);
  }
}

export class InMemoryUserRepository implements UserRepositoryPort {
  private readonly items = new Map<string, UserRecord>();

  async create(params: { id?: string; email: string; passwordHash: string }): Promise<UserRecord> {
    const record: UserRecord = {
      id: params.id ?? randomUUID(),
      email: params.email,
      passwordHash: params.passwordHash,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.items.set(record.id, record);
    return record;
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    return [...this.items.values()].find((item) => item.email === email) ?? null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    return this.items.get(id) ?? null;
  }

  async deleteById(id: string): Promise<boolean> {
    return this.items.delete(id);
  }
}

export class InMemorySessionRepository implements SessionRepositoryPort {
  private readonly items = new Map<string, SessionRecord>();

  async create(params: { userId: string; accountId: string; sessionTokenHash: string; expiresAt: Date }): Promise<SessionRecord> {
    const record: SessionRecord = {
      id: randomUUID(),
      userId: params.userId,
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

export class InMemoryAccountMembershipRepository implements AccountMembershipRepositoryPort {
  private readonly items = new Map<string, AccountMembershipRecord>();
  private userRepository: UserRepositoryPort | null = null;

  setUserRepository(userRepository: UserRepositoryPort): void {
    this.userRepository = userRepository;
  }

  async create(params: {
    accountId: string;
    userId: string;
    role: AccountMembershipRole;
    status?: AccountMembershipStatus;
  }): Promise<AccountMembershipRecord> {
    const existing = [...this.items.values()].find(
      (item) => item.accountId === params.accountId && item.userId === params.userId,
    );
    if (existing) {
      return existing;
    }

    const record: AccountMembershipRecord = {
      id: randomUUID(),
      accountId: params.accountId,
      userId: params.userId,
      role: params.role,
      status: params.status ?? "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.items.set(record.id, record);
    return record;
  }

  async findActiveByAccountAndUser(accountId: string, userId: string): Promise<AccountMembershipRecord | null> {
    return (
      [...this.items.values()].find(
        (item) => item.accountId === accountId && item.userId === userId && item.status === "active",
      ) ?? null
    );
  }

  async findById(id: string): Promise<AccountMembershipRecord | null> {
    return this.items.get(id) ?? null;
  }

  async listActiveByAccount(accountId: string): Promise<AccountMembershipUserRecord[]> {
    if (!this.userRepository) {
      throw new Error("User repository is required for membership listings");
    }

    const memberships = [...this.items.values()]
      .filter((item) => item.accountId === accountId && item.status === "active")
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());

    const users = await Promise.all(
      memberships.map(async (membership) => ({
        membership,
        user: await this.userRepository!.findById(membership.userId),
      })),
    );

    return users.map(({ membership, user }) => ({
      ...membership,
      email: user?.email ?? "unknown@example.com",
    }));
  }

  async listActiveByUser(userId: string): Promise<AccountMembershipRecord[]> {
    return [...this.items.values()]
      .filter((item) => item.userId === userId && item.status === "active")
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  }

  async deleteById(id: string): Promise<boolean> {
    return this.items.delete(id);
  }
}

export class InMemoryAccountInvitationRepository implements AccountInvitationRepositoryPort {
  private readonly items = new Map<string, AccountInvitationRecord>();

  async create(params: {
    accountId: string;
    email: string;
    invitedByMembershipId: string;
    tokenHash: string;
    status?: AccountInvitationStatus;
    expiresAt: Date;
  }): Promise<AccountInvitationRecord> {
    const record: AccountInvitationRecord = {
      id: randomUUID(),
      accountId: params.accountId,
      email: params.email,
      invitedByMembershipId: params.invitedByMembershipId,
      tokenHash: params.tokenHash,
      status: params.status ?? "pending",
      expiresAt: params.expiresAt,
      acceptedAt: null,
      acceptedByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.items.set(record.id, record);
    return record;
  }

  async findPendingByAccountAndEmail(accountId: string, email: string): Promise<AccountInvitationRecord | null> {
    return (
      [...this.items.values()].find(
        (item) => item.accountId === accountId && item.email === email && item.status === "pending",
      ) ?? null
    );
  }

  async findByTokenHash(tokenHash: string): Promise<AccountInvitationRecord | null> {
    return [...this.items.values()].find((item) => item.tokenHash === tokenHash) ?? null;
  }

  async listByAccount(accountId: string): Promise<AccountInvitationRecord[]> {
    return [...this.items.values()]
      .filter((item) => item.accountId === accountId)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  }

  async update(params: {
    id: string;
    status: AccountInvitationStatus;
    acceptedAt?: Date | null;
    acceptedByUserId?: string | null;
  }): Promise<AccountInvitationRecord> {
    const existing = this.items.get(params.id);
    if (!existing) {
      throw notFound("Invitation not found");
    }

    const updated: AccountInvitationRecord = {
      ...existing,
      status: params.status,
      acceptedAt: params.acceptedAt ?? null,
      acceptedByUserId: params.acceptedByUserId ?? null,
      updatedAt: new Date(),
    };
    this.items.set(updated.id, updated);
    return updated;
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
      anonymousChatEnabled: false,
      anonymousChatToken: null,
      anonymousRateLimit: 10,
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

  async findByAnonymousChatToken(token: string): Promise<WorkspaceRecord | null> {
    return [...this.items.values()].find((w) => w.anonymousChatToken === token) ?? null;
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

  async updateAnonymousChatSettings(
    workspaceId: string,
    enabled: boolean,
    token: string | null,
    rateLimit: number,
  ): Promise<WorkspaceRecord> {
    const item = this.items.get(workspaceId);
    if (!item) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }
    const updated = {
      ...item,
      anonymousChatEnabled: enabled,
      anonymousChatToken: token,
      anonymousRateLimit: rateLimit,
      updatedAt: new Date(),
    };
    this.items.set(workspaceId, updated);
    return updated;
  }

  async deleteById(workspaceId: string): Promise<boolean> {
    return this.items.delete(workspaceId);
  }
}

export class InMemoryAbuseControlRepository implements AbuseControlRepositoryPort {
  private readonly items = new Map<string, AbuseControlEntry>();

  async find(scope: string, subjectKey: string): Promise<AbuseControlEntry | null> {
    return this.items.get(`${scope}:${subjectKey}`) ?? null;
  }

  async save(input: {
    scope: string;
    subjectKey: string;
    attemptCount: number;
    windowStartedAt: Date;
    blockedUntil: Date | null;
  }): Promise<AbuseControlEntry> {
    const key = `${input.scope}:${input.subjectKey}`;
    const existing = this.items.get(key);
    const record: AbuseControlEntry = {
      scope: input.scope,
      subjectKey: input.subjectKey,
      attemptCount: input.attemptCount,
      windowStartedAt: input.windowStartedAt,
      blockedUntil: input.blockedUntil,
      createdAt: existing?.createdAt ?? new Date(),
      updatedAt: new Date(),
    };
    this.items.set(key, record);
    return record;
  }

  async deleteExpired(now: Date): Promise<void> {
    for (const [key, entry] of this.items.entries()) {
      if (entry.blockedUntil && entry.blockedUntil <= now) {
        this.items.delete(key);
        continue;
      }
      if (!entry.blockedUntil && now.getTime() - entry.windowStartedAt.getTime() > 24 * 60 * 60 * 1000) {
        this.items.delete(key);
      }
    }
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
      semanticRewriteInstructions: input.semanticRewriteInstructions,
      lexicalRewriteInstructions: input.lexicalRewriteInstructions,
      answerSupportPolicy: input.answerSupportPolicy,
      rerankEnabled: input.rerankEnabled,
      vectorTopK: input.vectorTopK,
      similarityThreshold: input.similarityThreshold,
      rerankTopK: input.rerankTopK,
      citationDisplayEnabled: input.citationDisplayEnabled,
      metadataRules: input.metadataRules,
      customInstruction: input.customInstruction,
      createdAt: existing?.createdAt ?? new Date(),
      updatedAt: new Date(),
    };
    this.items.set(workspaceId, record);
    return record;
  }
}

export class InMemoryIngestionSettingsRepository implements IngestionSettingsRepositoryPort {
  private readonly items = new Map<string, IngestionSettingsRecord>();

  async findByWorkspaceId(workspaceId: string): Promise<IngestionSettingsRecord | null> {
    return this.items.get(workspaceId) ?? null;
  }

  async upsert(workspaceId: string, input: IngestionSettingsInput): Promise<IngestionSettingsRecord> {
    const existing = this.items.get(workspaceId);
    const record: IngestionSettingsRecord = {
      workspaceId,
      chunkingStrategy: input.chunkingStrategy,
      fixedWindowChunkSize: input.fixedWindowChunkSize,
      fixedWindowChunkOverlap: input.fixedWindowChunkOverlap,
      structuredMinChunkSize: input.structuredMinChunkSize,
      structuredMaxChunkSize: input.structuredMaxChunkSize,
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

  async createAndQueue(input: DocumentCreateInput): Promise<DocumentRecord> {
    const record: DocumentRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      title: input.title,
      sourceContent: input.sourceContent,
      markdownContent: input.markdownContent,
      metadata: input.metadata ?? {},
      externalDocumentId: input.externalDocumentId ?? null,
      sourceKind: input.sourceKind ?? "inline_text",
      sourceFilename: input.sourceFilename ?? null,
      sourceMimeType: input.sourceMimeType ?? null,
      sourceStorageBucket: input.sourceStorageBucket ?? null,
      sourceStorageObject: input.sourceStorageObject ?? null,
      sourceStorageGeneration: input.sourceStorageGeneration ?? null,
      sourceSizeBytes: input.sourceSizeBytes ?? null,
      status: "queued",
      revision: 1,
      failureReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    if (record.externalDocumentId) {
      const existing = [...this.items.values()].find(
        (item) => item.workspaceId === record.workspaceId && item.externalDocumentId === record.externalDocumentId,
      );

      if (existing) {
        if (existing.sourceKind !== record.sourceKind) {
          throw conflict("Imported documents cannot be updated through the inline document API");
        }

        const updated: DocumentRecord = {
          ...existing,
          title: record.title,
          sourceContent: record.sourceContent,
          markdownContent: record.markdownContent,
          metadata: record.metadata,
          status: "queued",
          revision: existing.revision + 1,
          failureReason: null,
          updatedAt: new Date(),
        };

        await this.jobRepository?.enqueue({
          documentId: updated.id,
          workspaceId: updated.workspaceId,
          documentRevision: updated.revision,
        });
        this.items.set(updated.id, updated);
        return updated;
      }
    }

    await this.jobRepository?.enqueue({
      documentId: record.id,
      workspaceId: record.workspaceId,
      documentRevision: record.revision,
    });
    this.items.set(record.id, record);
    return record;
  }

  async create(input: DocumentCreateInput & { status: string }): Promise<DocumentRecord> {
    const record: DocumentRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      title: input.title,
      sourceContent: input.sourceContent,
      markdownContent: input.markdownContent,
      metadata: input.metadata ?? {},
      externalDocumentId: input.externalDocumentId ?? null,
      sourceKind: input.sourceKind ?? "inline_text",
      sourceFilename: input.sourceFilename ?? null,
      sourceMimeType: input.sourceMimeType ?? null,
      sourceStorageBucket: input.sourceStorageBucket ?? null,
      sourceStorageObject: input.sourceStorageObject ?? null,
      sourceStorageGeneration: input.sourceStorageGeneration ?? null,
      sourceSizeBytes: input.sourceSizeBytes ?? null,
      status: input.status,
      revision: 1,
      failureReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.items.set(record.id, record);
    return record;
  }

  async listMetadataFieldSuggestions(workspaceId: string): Promise<MetadataFieldSuggestion[]> {
    const fields = new Map<string, MetadataValueType>();

    for (const document of this.items.values()) {
      if (document.workspaceId !== workspaceId) {
        continue;
      }

      for (const entry of collectMetadataPaths(document.metadata ?? {})) {
        const existing = fields.get(entry.path);
        fields.set(entry.path, existing && existing !== entry.inferredType ? "string" : entry.inferredType);
      }
    }

    return [...fields.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([field, inferredType]) => ({ field, inferredType }));
  }

  async listByWorkspaceId(workspaceId: string): Promise<DocumentRecord[]> {
    return [...this.items.values()]
      .filter((item) => item.workspaceId === workspaceId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async listSummariesByIdsAndWorkspaceId(workspaceId: string, documentIds: string[]): Promise<DocumentSummaryRecord[]> {
    const allowedIds = new Set(documentIds);

    return [...this.items.values()]
      .filter((item) => item.workspaceId === workspaceId && allowedIds.has(item.id))
      .map((item) => ({
        id: item.id,
        workspaceId: item.workspaceId,
        title: item.title,
        status: item.status,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        metadata: item.metadata,
        externalDocumentId: item.externalDocumentId ?? null,
        sourceKind: item.sourceKind,
        sourceFilename: item.sourceFilename,
        sourceMimeType: item.sourceMimeType,
        sourceStorageBucket: item.sourceStorageBucket,
        sourceStorageObject: item.sourceStorageObject,
        sourceStorageGeneration: item.sourceStorageGeneration,
        sourceSizeBytes: item.sourceSizeBytes,
      }));
  }

  async listSummaryPageByWorkspaceId(
    workspaceId: string,
    input: { limit: number; offset?: number; cursor?: string },
  ): Promise<{ documents: DocumentSummaryRecord[]; total: number; nextCursor: string | null; hasMore: boolean }> {
    const documents = [...this.items.values()]
      .filter((item) => item.workspaceId === workspaceId)
      .sort((a, b) => {
        const timeDiff = b.createdAt.getTime() - a.createdAt.getTime();
        return timeDiff !== 0 ? timeDiff : b.id.localeCompare(a.id);
      });

    const cursor = input.cursor ? decodeCursorWithKeys(input.cursor, ["createdAt", "id"]) : null;
    const startIndex = cursor
      ? documents.findIndex(
          (item) => item.createdAt.toISOString() === cursor.keys.createdAt && item.id === cursor.keys.id,
        ) + 1
      : (input.offset ?? 0);
    const slice = documents.slice(Math.max(0, startIndex), Math.max(0, startIndex) + input.limit);
    const hasMore = Math.max(0, startIndex) + input.limit < documents.length;
    const lastDocument = slice.at(-1);

    return {
      documents: slice,
      total: documents.length,
      nextCursor: hasMore && lastDocument
        ? encodeCursor({
            createdAt: lastDocument.createdAt.toISOString(),
            id: lastDocument.id,
          })
        : null,
      hasMore,
    };
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

  async update(input: DocumentUpdateInput): Promise<DocumentRecord> {
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
      externalDocumentId: input.externalDocumentId ?? existing.externalDocumentId ?? null,
      sourceKind: input.sourceKind ?? existing.sourceKind,
      sourceFilename: input.sourceFilename ?? existing.sourceFilename ?? null,
      sourceMimeType: input.sourceMimeType ?? existing.sourceMimeType ?? null,
      sourceStorageBucket: input.sourceStorageBucket ?? existing.sourceStorageBucket ?? null,
      sourceStorageObject: input.sourceStorageObject ?? existing.sourceStorageObject ?? null,
      sourceStorageGeneration: input.sourceStorageGeneration ?? existing.sourceStorageGeneration ?? null,
      sourceSizeBytes: input.sourceSizeBytes ?? existing.sourceSizeBytes ?? null,
      status: input.status,
      revision: existing.revision + 1,
      failureReason: null,
      updatedAt: new Date(),
    };
    this.items.set(record.id, record);
    return record;
  }

  async updateAndQueue(input: DocumentQueueUpdateInput): Promise<DocumentRecord> {
    const existing = this.items.get(input.documentId);
    if (!existing || existing.workspaceId !== input.workspaceId) {
      throw notFound("Document not found");
    }

    if (input.externalDocumentId && input.externalDocumentId !== existing.externalDocumentId) {
      const claimedByOther = [...this.items.values()].find(
        (item) =>
          item.workspaceId === input.workspaceId &&
          item.id !== input.documentId &&
          item.externalDocumentId === input.externalDocumentId,
      );
      if (claimedByOther) {
        throw conflict("externalDocumentId is already used by another document in this workspace");
      }
    }

    const record: DocumentRecord = {
      ...existing,
      title: input.title,
      sourceContent: input.sourceContent,
      markdownContent: input.markdownContent,
      metadata: input.metadata ?? existing.metadata ?? {},
      externalDocumentId: input.externalDocumentId ?? existing.externalDocumentId ?? null,
      sourceKind: input.sourceKind ?? existing.sourceKind,
      sourceFilename: input.sourceFilename ?? existing.sourceFilename ?? null,
      sourceMimeType: input.sourceMimeType ?? existing.sourceMimeType ?? null,
      sourceStorageBucket: input.sourceStorageBucket ?? existing.sourceStorageBucket ?? null,
      sourceStorageObject: input.sourceStorageObject ?? existing.sourceStorageObject ?? null,
      sourceStorageGeneration: input.sourceStorageGeneration ?? existing.sourceStorageGeneration ?? null,
      sourceSizeBytes: input.sourceSizeBytes ?? existing.sourceSizeBytes ?? null,
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

  async updateDerivedContentForRevision(input: DocumentDerivedContentUpdateInput): Promise<DocumentRecord | null> {
    const existing = this.items.get(input.documentId);
    if (!existing || existing.workspaceId !== input.workspaceId || existing.revision !== input.revision) {
      return null;
    }

    const record: DocumentRecord = {
      ...existing,
      sourceContent: input.sourceContent,
      markdownContent: input.markdownContent,
      updatedAt: new Date(),
    };
    this.items.set(record.id, record);
    return record;
  }

  async requeueAllEligibleAndQueue(workspaceId: string): Promise<{ queuedDocumentCount: number; skippedDocumentCount: number }> {
    const documents = [...this.items.values()].filter((item) => item.workspaceId === workspaceId);
    let queuedDocumentCount = 0;
    let skippedDocumentCount = 0;

    for (const document of documents) {
      if (document.status === "queued" || document.status === "processing") {
        skippedDocumentCount += 1;
        continue;
      }

      const record: DocumentRecord = {
        ...document,
        status: "queued",
        metadata: document.metadata ?? {},
        revision: document.revision + 1,
        failureReason: null,
        updatedAt: new Date(),
      };

      await this.jobRepository?.enqueue({
        documentId: record.id,
        workspaceId: record.workspaceId,
        documentRevision: record.revision,
      });
      this.items.set(record.id, record);
      queuedDocumentCount += 1;
    }

    return {
      queuedDocumentCount,
      skippedDocumentCount,
    };
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

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isScalarMetadataValue = (value: unknown): boolean =>
  value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";

const collectMetadataPaths = (
  metadata: Record<string, unknown>,
  prefix = "",
): Array<{ path: string; inferredType: MetadataValueType }> => {
  const paths: Array<{ path: string; inferredType: MetadataValueType }> = [];

  for (const [key, value] of Object.entries(metadata)) {
    const nextPath = prefix ? `${prefix}.${key}` : key;

    if (isScalarMetadataValue(value)) {
      paths.push({
        path: nextPath,
        inferredType: inferMetadataValueType(value),
      });
      continue;
    }

    if (isPlainObject(value)) {
      paths.push(...collectMetadataPaths(value, nextPath));
    }
  }

  return paths;
};

export class InMemoryDocumentStorage implements DocumentStoragePort {
  readonly objects = new Map<string, { buffer: Buffer; generation: string; sizeBytes: number }>();
  deleteFailures = new Set<string>();

  async upload(input: DocumentStorageUploadInput) {
    const objectPath = `workspaces/${input.workspaceId}/documents/${input.documentId}/${input.filename}`;
    const generation = `${this.objects.size + 1}`;
    this.objects.set(objectPath, {
      buffer: Buffer.from(input.buffer),
      generation,
      sizeBytes: input.buffer.length,
    });

    return {
      bucket: "test-document-imports",
      objectPath,
      generation,
      sizeBytes: input.buffer.length,
    };
  }

  async read(input: DocumentStorageReadInput): Promise<Buffer> {
    const existing = this.objects.get(input.objectPath);
    if (!existing) {
      throw new Error(`Missing object ${input.objectPath}`);
    }

    return Buffer.from(existing.buffer);
  }

  async delete(input: DocumentStorageDeleteInput): Promise<void> {
    if (this.deleteFailures.has(input.objectPath)) {
      throw new Error(`Failed to delete ${input.objectPath}`);
    }

    this.objects.delete(input.objectPath);
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

  async backfillMissingQueuedJobs(limit = 100): Promise<number> {
    const queuedDocuments = [...(this.documentRepository?.items.values() ?? [])]
      .filter((document) => document.status === "queued")
      .filter((document) =>
        ![...this.items.values()].some(
          (job) => job.documentId === document.id && job.documentRevision === document.revision,
        ),
      )
      .sort((left, right) => left.updatedAt.getTime() - right.updatedAt.getTime())
      .slice(0, limit);

    for (const document of queuedDocuments) {
      await this.enqueue({
        documentId: document.id,
        workspaceId: document.workspaceId,
        documentRevision: document.revision,
      });
    }

    return queuedDocuments.length;
  }

  async listProcessingJobs(): Promise<DocumentProcessingJobRecord[]> {
    return [...this.items.values()]
      .filter((item) => item.status === "processing")
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  }

  async getQueueSnapshot(now: Date = new Date()): Promise<DocumentProcessingQueueSnapshot> {
    const queuedJobs = [...this.items.values()]
      .filter((item) => item.status === "queued" && item.availableAt <= now)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    const processingJobs = [...this.items.values()].filter((item) => item.status === "processing");

    return {
      queuedJobCount: queuedJobs.length,
      processingJobCount: processingJobs.length,
      oldestQueuedJobCreatedAt: queuedJobs[0]?.createdAt ?? null,
    };
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

  async create(workspaceId: string, sourceChannel: string | null = null, anonymousSessionId: string | null = null): Promise<ConversationRecord> {
    const record: ConversationRecord = {
      id: randomUUID(),
      workspaceId,
      sourceChannel,
      anonymousSessionId,
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

  async listPageByWorkspaceId(
    workspaceId: string,
    input: { limit: number; offset?: number; cursor?: string } = { limit: 50, offset: 0 },
  ): Promise<{ conversations: ConversationRecord[]; total: number; nextCursor: string | null; hasMore: boolean }> {
    const conversations = [...this.items.values()]
      .filter((item) => item.workspaceId === workspaceId)
      .sort((left, right) => {
        const timeDiff = right.updatedAt.getTime() - left.updatedAt.getTime();
        return timeDiff !== 0 ? timeDiff : right.id.localeCompare(left.id);
      });

    const cursor = input.cursor ? decodeCursorWithKeys(input.cursor, ["updatedAt", "createdAt", "id"]) : null;
    const startIndex = cursor
      ? conversations.findIndex(
          (item) => item.updatedAt.toISOString() === cursor.keys.updatedAt && item.id === cursor.keys.id,
        ) + 1
      : (input.offset ?? 0);
    const slice = conversations.slice(Math.max(0, startIndex), Math.max(0, startIndex) + input.limit);
    const hasMore = Math.max(0, startIndex) + input.limit < conversations.length;
    const lastConversation = slice.at(-1);

    return {
      conversations: slice,
      total: conversations.length,
      nextCursor: hasMore && lastConversation
        ? encodeCursor({
            updatedAt: lastConversation.updatedAt.toISOString(),
            createdAt: lastConversation.createdAt.toISOString(),
            id: lastConversation.id,
          })
        : null,
      hasMore,
    };
  }

  async listByAnonymousSession(workspaceId: string, anonymousSessionId: string): Promise<ConversationRecord[]> {
    return [...this.items.values()]
      .filter((item) => item.workspaceId === workspaceId && item.anonymousSessionId === anonymousSessionId)
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
  }

  async listPageByAnonymousSession(
    workspaceId: string,
    anonymousSessionId: string,
    input: { limit: number; offset?: number; cursor?: string } = { limit: 50, offset: 0 },
  ): Promise<{ conversations: ConversationRecord[]; total: number; nextCursor: string | null; hasMore: boolean }> {
    const conversations = [...this.items.values()]
      .filter((item) => item.workspaceId === workspaceId && item.anonymousSessionId === anonymousSessionId)
      .sort((left, right) => {
        const timeDiff = right.updatedAt.getTime() - left.updatedAt.getTime();
        return timeDiff !== 0 ? timeDiff : right.id.localeCompare(left.id);
      });

    const cursor = input.cursor ? decodeCursorWithKeys(input.cursor, ["updatedAt", "createdAt", "id"]) : null;
    const startIndex = cursor
      ? conversations.findIndex(
          (item) => item.updatedAt.toISOString() === cursor.keys.updatedAt && item.id === cursor.keys.id,
        ) + 1
      : (input.offset ?? 0);
    const slice = conversations.slice(Math.max(0, startIndex), Math.max(0, startIndex) + input.limit);
    const hasMore = Math.max(0, startIndex) + input.limit < conversations.length;
    const lastConversation = slice.at(-1);

    return {
      conversations: slice,
      total: conversations.length,
      nextCursor: hasMore && lastConversation
        ? encodeCursor({
            updatedAt: lastConversation.updatedAt.toISOString(),
            createdAt: lastConversation.createdAt.toISOString(),
            id: lastConversation.id,
          })
        : null,
      hasMore,
    };
  }

  async findByIdAndAnonymousSession(
    conversationId: string,
    workspaceId: string,
    anonymousSessionId: string,
  ): Promise<ConversationRecord | null> {
    const item = this.items.get(conversationId);
    return item && item.workspaceId === workspaceId && item.anonymousSessionId === anonymousSessionId ? item : null;
  }

  async touch(conversationId: string, workspaceId: string): Promise<void> {
    const item = this.items.get(conversationId);
    if (item && item.workspaceId === workspaceId) {
      item.updatedAt = new Date();
    }
  }
}

export class InMemoryMessageRepository implements MessageRepositoryPort {
  readonly items = new Map<string, MessageRecord[]>();

  async listByConversationId(workspaceId: string, conversationId: string): Promise<MessageRecord[]> {
    return [...(this.items.get(conversationId) ?? [])].filter((message) => message.workspaceId === workspaceId);
  }

  async listWindowByConversationId(
    workspaceId: string,
    conversationId: string,
    input: { limit: number; offset?: number; cursor?: string } = { limit: 50, offset: 0 },
  ): Promise<{ messages: MessageRecord[]; total: number; nextCursor: string | null; hasMore: boolean }> {
    const messages = [...(this.items.get(conversationId) ?? [])].filter((message) => message.workspaceId === workspaceId);
    const latestFirst = [...messages].sort((left, right) => {
      const timeDiff = right.createdAt.getTime() - left.createdAt.getTime();
      return timeDiff !== 0 ? timeDiff : right.id.localeCompare(left.id);
    });
    const cursor = input.cursor ? decodeCursorWithKeys(input.cursor, ["createdAt", "id"]) : null;
    const startIndex = cursor
      ? latestFirst.findIndex(
          (item) => item.createdAt.toISOString() === cursor.keys.createdAt && item.id === cursor.keys.id,
        ) + 1
      : (input.offset ?? 0);
    const slice = latestFirst.slice(Math.max(0, startIndex), Math.max(0, startIndex) + input.limit);
    const hasMore = Math.max(0, startIndex) + input.limit < latestFirst.length;
    const oldestFetched = slice.at(-1);

    return {
      messages: [...slice].reverse(),
      total: messages.length,
      nextCursor: hasMore && oldestFetched
        ? encodeCursor({
            createdAt: oldestFetched.createdAt.toISOString(),
            id: oldestFetched.id,
          })
        : null,
      hasMore,
    };
  }

  async summarizeByConversationIds(
    workspaceId: string,
    conversationIds: string[],
  ): Promise<Map<string, ConversationMessageSummary>> {
    const summaries = new Map<string, ConversationMessageSummary>();

    for (const conversationId of conversationIds) {
      const messages = (this.items.get(conversationId) ?? []).filter((message) => message.workspaceId === workspaceId);
      const latestMessage = [...messages].reverse().find((message) => message.content.trim().length > 0);
      const normalized = latestMessage?.content.replace(/\s+/g, " ").trim() ?? "";
      summaries.set(conversationId, {
        messageCount: messages.length,
        userMessageCount: messages.filter((message) => message.role === "user").length,
        assistantMessageCount: messages.filter((message) => message.role === "assistant").length,
        preview: normalized.length === 0 ? null : normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized,
      });
    }

    return summaries;
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

  async listChatAnswerEventsByAssistantMessageIds(
    workspaceId: string,
    conversationId: string,
    assistantMessageIds: string[],
  ): Promise<AuditEventRecord[]> {
    return this.items.filter((event) => {
      return (
        event.workspaceId === workspaceId &&
        event.eventType === "chat.answer" &&
        event.metadata.conversationId === conversationId &&
        typeof event.metadata.assistantMessageId === "string" &&
        assistantMessageIds.includes(event.metadata.assistantMessageId)
      );
    });
  }

  async listDocumentSearchEventsByWorkspaceId(workspaceId: string): Promise<AuditEventRecord[]> {
    return this.items
      .filter((event) => event.workspaceId === workspaceId && event.eventType === "document.search")
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  }

  async listDocumentSearchEventPageByWorkspaceId(
    workspaceId: string,
    input: { limit: number; offset?: number; cursor?: string } = { limit: 50, offset: 0 },
  ): Promise<{ events: AuditEventRecord[]; total: number; nextCursor: string | null; hasMore: boolean }> {
    const events = this.items
      .filter((event) => event.workspaceId === workspaceId && event.eventType === "document.search")
      .sort((left, right) => {
        const timeDiff = right.createdAt.getTime() - left.createdAt.getTime();
        return timeDiff !== 0 ? timeDiff : right.id.localeCompare(left.id);
      });
    const cursor = input.cursor ? decodeCursorWithKeys(input.cursor, ["createdAt", "id"]) : null;
    const startIndex = cursor
      ? events.findIndex((item) => item.createdAt.toISOString() === cursor.keys.createdAt && item.id === cursor.keys.id) + 1
      : (input.offset ?? 0);
    const slice = events.slice(Math.max(0, startIndex), Math.max(0, startIndex) + input.limit);
    const hasMore = Math.max(0, startIndex) + input.limit < events.length;
    const lastEvent = slice.at(-1);

    return {
      events: slice,
      total: events.length,
      nextCursor: hasMore && lastEvent
        ? encodeCursor({
            createdAt: lastEvent.createdAt.toISOString(),
            id: lastEvent.id,
          })
        : null,
      hasMore,
    };
  }

  async findDocumentSearchEventBySearchId(workspaceId: string, searchId: string): Promise<AuditEventRecord | null> {
    return (
      this.items.find((event) => {
        return (
          event.workspaceId === workspaceId &&
          event.eventType === "document.search" &&
          event.metadata.searchId === searchId
        );
      }) ?? null
    );
  }
}

export class InMemoryEvalRepository implements EvalRepositoryPort {
  readonly datasets = new Map<string, EvalDatasetRecord>();
  readonly cases = new Map<string, EvalCaseRecord[]>();
  readonly runs = new Map<string, EvalRunRecord[]>();

  async listDatasets(workspaceId: string): Promise<EvalDatasetSummary[]> {
    return [...this.datasets.values()]
      .filter((dataset) => dataset.workspaceId === workspaceId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((dataset) => {
        const datasetCases = this.cases.get(dataset.id) ?? [];
        const datasetRuns = this.runs.get(dataset.id) ?? [];
        return {
          ...dataset,
          caseCount: datasetCases.length,
          runCount: datasetRuns.length,
          lastRunAt: datasetRuns[0]?.completedAt ?? null,
        };
      });
  }

  async createDataset(
    workspaceId: string,
    input: { name: string; description?: string; createdByAccountId?: string | null },
  ): Promise<EvalDatasetRecord> {
    const now = new Date().toISOString();
    const dataset: EvalDatasetRecord = {
      id: randomUUID(),
      workspaceId,
      name: input.name,
      description: input.description ?? "",
      status: "active",
      createdByAccountId: input.createdByAccountId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.datasets.set(dataset.id, dataset);
    this.cases.set(dataset.id, []);
    this.runs.set(dataset.id, []);
    return dataset;
  }

  async findDatasetById(workspaceId: string, datasetId: string): Promise<EvalDatasetRecord | null> {
    const dataset = this.datasets.get(datasetId);
    return dataset && dataset.workspaceId === workspaceId ? dataset : null;
  }

  async listCases(datasetId: string): Promise<EvalCaseRecord[]> {
    return [...(this.cases.get(datasetId) ?? [])];
  }

  async createCase(workspaceId: string, datasetId: string, input: EvalCaseCreateInput): Promise<EvalCaseRecord> {
    const now = new Date().toISOString();
    const evalCase: EvalCaseRecord = {
      id: randomUUID(),
      datasetId,
      workspaceId,
      title: input.title,
      sourceType: input.sourceType ?? "manual",
      query: input.query,
      conversationContext: input.conversationContext ?? [],
      expectations: input.expectations ?? {},
      provenance: input.provenance ?? {},
      createdAt: now,
      updatedAt: now,
    };
    const items = this.cases.get(datasetId) ?? [];
    items.push(evalCase);
    this.cases.set(datasetId, items);
    const dataset = this.datasets.get(datasetId);
    if (dataset) {
      dataset.updatedAt = now;
    }
    return evalCase;
  }

  async listRuns(datasetId: string): Promise<EvalRunRecord[]> {
    return [...(this.runs.get(datasetId) ?? [])].sort((left, right) => right.completedAt.localeCompare(left.completedAt));
  }

  async createRun(
    workspaceId: string,
    datasetId: string,
    input: {
      label?: string | null;
      baselineRunId?: string | null;
      createdByAccountId?: string | null;
      runMetadata?: Record<string, unknown>;
      summary: EvalRunRecord["summary"];
      results: EvalRunRecord["results"];
    },
  ): Promise<EvalRunRecord> {
    const now = new Date().toISOString();
    const run: EvalRunRecord = {
      id: randomUUID(),
      datasetId,
      workspaceId,
      label: input.label ?? null,
      baselineRunId: input.baselineRunId ?? null,
      createdByAccountId: input.createdByAccountId ?? null,
      runMetadata: input.runMetadata ?? {},
      summary: input.summary,
      results: input.results,
      startedAt: now,
      completedAt: now,
    };
    const items = this.runs.get(datasetId) ?? [];
    items.unshift(run);
    this.runs.set(datasetId, items);
    const dataset = this.datasets.get(datasetId);
    if (dataset) {
      dataset.updatedAt = now;
    }
    return run;
  }

  async findRunById(workspaceId: string, datasetId: string, runId: string): Promise<EvalRunRecord | null> {
    const run = (this.runs.get(datasetId) ?? []).find((entry) => entry.id === runId);
    return run && run.workspaceId === workspaceId ? run : null;
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
