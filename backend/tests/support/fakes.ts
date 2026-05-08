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
  AccountInvitationRole,
  AccountInvitationRepositoryPort,
  AccountInvitationStatus,
} from "../../src/db/repositories/accountInvitationRepository.js";
import type {
  WorkspaceGrantRecord,
  WorkspaceGrantRepositoryPort,
  WorkspaceGrantRole,
} from "../../src/db/repositories/workspaceGrantRepository.js";
import type {
  SupportImpersonationRecord,
  SupportImpersonationRepositoryPort,
} from "../../src/db/repositories/supportImpersonationRepository.js";
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
import type {
  BootstrapGreetingCacheRecord,
  BootstrapGreetingCacheRepositoryPort,
} from "../../src/db/repositories/bootstrapGreetingCacheRepository.js";
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
import type {
  HistoryItemsRepositoryPort,
  HistoryItemsSourceRecord,
} from "../../src/db/repositories/historyItemsRepository.js";
import type { AuditEventInput } from "../../src/modules/audit/contracts/index.js";
import type {
  ConversationMessageSummary,
  MessageRecord,
  MessageRepositoryPort,
} from "../../src/db/repositories/messageRepository.js";
import type {
  IngestionSettingsInput,
  IngestionSettingsRecord,
} from "../../src/modules/settings/contracts/ingestion.js";
import {
  inferMetadataValueType,
  type MetadataFieldSuggestion,
  type MetadataValueType,
  type RetrievalSettingsInput,
  type RetrievalSettingsRecord,
} from "../../src/modules/settings/contracts/retrieval.js";
import type {
  IngestionSettingsRepositoryPort,
  RetrievalSettingsRepositoryPort,
} from "../../src/modules/settings/contracts/services.js";
import { AuditService } from "../../src/modules/audit/services/auditService.js";
import type {
  DocumentStorageDeleteInput,
  DocumentStoragePort,
  DocumentStorageReadInput,
  DocumentStorageUploadInput,
} from "../../src/modules/documents/contracts/storage.js";
import { createWorkspacePublicRouteKey } from "../../src/modules/workspace/domain/publicRouteKey.js";
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

  async create(params: { id?: string; email: string; passwordHash: string; emailVerifiedAt?: Date | null }): Promise<UserRecord> {
    const record: UserRecord = {
      id: params.id ?? randomUUID(),
      email: params.email,
      passwordHash: params.passwordHash,
      emailVerifiedAt: params.emailVerifiedAt === undefined ? new Date() : params.emailVerifiedAt,
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

  async updatePassword(id: string, passwordHash: string): Promise<UserRecord> {
    const existing = this.items.get(id);
    if (!existing) {
      throw notFound("User not found");
    }

    const updated: UserRecord = {
      ...existing,
      passwordHash,
      updatedAt: new Date(),
    };
    this.items.set(id, updated);
    return updated;
  }

  async markEmailVerified(id: string, verifiedAt: Date): Promise<UserRecord> {
    const existing = this.items.get(id);
    if (!existing) {
      throw notFound("User not found");
    }

    const updated: UserRecord = {
      ...existing,
      emailVerifiedAt: existing.emailVerifiedAt ?? verifiedAt,
      updatedAt: new Date(),
    };
    this.items.set(id, updated);
    return updated;
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

  async revokeAllForUser(userId: string, revokedAt: Date): Promise<number> {
    let count = 0;
    for (const item of this.items.values()) {
      if (item.userId === userId && item.revokedAt === null) {
        item.revokedAt = revokedAt;
        count += 1;
      }
    }

    return count;
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

  async updateRole(id: string, role: AccountMembershipRole): Promise<AccountMembershipRecord> {
    const existing = this.items.get(id);
    if (!existing) {
      throw notFound("Membership not found");
    }
    const updated = {
      ...existing,
      role,
      updatedAt: new Date(),
    };
    this.items.set(id, updated);
    return updated;
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
    role?: AccountInvitationRole;
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
      role: params.role ?? "member",
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

export class InMemoryWorkspaceGrantRepository implements WorkspaceGrantRepositoryPort {
  private readonly items = new Map<string, WorkspaceGrantRecord>();

  async upsert(input: {
    workspaceId: string;
    accountId: string;
    userId: string;
    role: WorkspaceGrantRole;
  }): Promise<WorkspaceGrantRecord> {
    const existing = [...this.items.values()].find(
      (item) => item.workspaceId === input.workspaceId && item.userId === input.userId,
    );
    const record: WorkspaceGrantRecord = {
      id: existing?.id ?? randomUUID(),
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      userId: input.userId,
      role: input.role,
      createdAt: existing?.createdAt ?? new Date(),
      updatedAt: new Date(),
    };
    this.items.set(record.id, record);
    return record;
  }

  async findByWorkspaceAndUser(workspaceId: string, userId: string): Promise<WorkspaceGrantRecord | null> {
    return [...this.items.values()].find((item) => item.workspaceId === workspaceId && item.userId === userId) ?? null;
  }

  async listByAccount(accountId: string): Promise<WorkspaceGrantRecord[]> {
    return [...this.items.values()].filter((item) => item.accountId === accountId);
  }

  async listByWorkspace(workspaceId: string): Promise<WorkspaceGrantRecord[]> {
    return [...this.items.values()].filter((item) => item.workspaceId === workspaceId);
  }

  async deleteByAccountAndUser(accountId: string, userId: string): Promise<number> {
    const matches = [...this.items.values()].filter((item) => item.accountId === accountId && item.userId === userId);
    for (const match of matches) {
      this.items.delete(match.id);
    }
    return matches.length;
  }

  async deleteByWorkspaceAndUser(workspaceId: string, accountId: string, userId: string): Promise<boolean> {
    const existing = [...this.items.values()].find(
      (item) => item.workspaceId === workspaceId && item.accountId === accountId && item.userId === userId,
    );
    if (!existing) {
      return false;
    }
    return this.items.delete(existing.id);
  }
}

export class InMemorySupportImpersonationRepository implements SupportImpersonationRepositoryPort {
  private readonly items = new Map<string, SupportImpersonationRecord>();

  async createApproved(input: {
    accountId: string;
    staffUserId: string;
    approverUserId: string;
    reason: string;
    expiresAt: Date;
  }): Promise<SupportImpersonationRecord> {
    const now = new Date();
    const record: SupportImpersonationRecord = {
      id: randomUUID(),
      accountId: input.accountId,
      staffUserId: input.staffUserId,
      approverUserId: input.approverUserId,
      reason: input.reason,
      status: "approved",
      approvedAt: now,
      startedAt: null,
      expiresAt: input.expiresAt,
      endedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.items.set(record.id, record);
    return record;
  }

  async findById(id: string): Promise<SupportImpersonationRecord | null> {
    return this.items.get(id) ?? null;
  }

  async listByAccount(accountId: string, now: Date): Promise<SupportImpersonationRecord[]> {
    void now;
    return [...this.items.values()].filter((item) => item.accountId === accountId);
  }

  async markStarted(id: string, startedAt: Date): Promise<SupportImpersonationRecord> {
    const existing = this.items.get(id);
    if (!existing) {
      throw notFound("Support impersonation session not found");
    }
    const updated: SupportImpersonationRecord = {
      ...existing,
      status: "active",
      startedAt: existing.startedAt ?? startedAt,
      updatedAt: new Date(),
    };
    this.items.set(id, updated);
    return updated;
  }

  async end(id: string, status: "ended" | "expired" | "revoked", endedAt: Date): Promise<SupportImpersonationRecord> {
    const existing = this.items.get(id);
    if (!existing) {
      throw notFound("Support impersonation session not found");
    }
    const updated: SupportImpersonationRecord = {
      ...existing,
      status,
      endedAt: existing.endedAt ?? endedAt,
      updatedAt: new Date(),
    };
    this.items.set(id, updated);
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

  async create(accountId: string, name: string, publicRouteKey?: string): Promise<WorkspaceRecord> {
    const record: WorkspaceRecord = {
      id: randomUUID(),
      accountId,
      name,
      publicRouteKey: publicRouteKey ?? createWorkspacePublicRouteKey(name, randomUUID),
      assistantName: "",
      greetingInstruction: "",
      assistantDefaultLocale: null,
      proactiveGreetingEnabled: false,
      anonymousChatEnabled: false,
      anonymousChatToken: null,
      anonymousRateLimit: 10,
      websiteEmbedEnabled: false,
      websiteEmbedToken: null,
      websiteEmbedAllowedOrigins: [],
      websiteEmbedLauncherLabel: "Chat with us",
      websiteEmbedLauncherIcon: "chat",
      websiteEmbedLauncherPosition: "bottom-right",
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

  async findByPublicRouteKey(publicRouteKey: string): Promise<WorkspaceRecord | null> {
    return [...this.items.values()].find((w) => w.publicRouteKey === publicRouteKey) ?? null;
  }

  async findByAnonymousChatToken(token: string): Promise<WorkspaceRecord | null> {
    return [...this.items.values()].find((w) => w.anonymousChatToken === token) ?? null;
  }

  async findByWebsiteEmbedToken(token: string): Promise<WorkspaceRecord | null> {
    return [...this.items.values()].find((w) => w.websiteEmbedToken === token) ?? null;
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

  async updateAssistantBootstrapSettings(
    workspaceId: string,
    input: {
      assistantName?: string;
      greetingInstruction?: string;
      assistantDefaultLocale?: string | null;
      proactiveGreetingEnabled?: boolean;
    },
  ): Promise<WorkspaceRecord> {
    const item = this.items.get(workspaceId);
    if (!item) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }

    const updated = {
      ...item,
      assistantName: input.assistantName?.trim().replace(/\s+/g, " ") ?? "",
      greetingInstruction: input.greetingInstruction?.trim().replace(/\s+/g, " ") ?? "",
      assistantDefaultLocale: input.assistantDefaultLocale?.trim() || null,
      proactiveGreetingEnabled: Boolean(input.proactiveGreetingEnabled),
      updatedAt: new Date(),
    };
    this.items.set(workspaceId, updated);
    return updated;
  }

  async updateGeneralSettings(
    workspaceId: string,
    input: {
      anonymousChatEnabled: boolean;
      anonymousChatToken: string | null;
      anonymousRateLimit: number;
      assistantName: string;
      greetingInstruction: string;
      assistantDefaultLocale: string | null;
      proactiveGreetingEnabled: boolean;
      websiteEmbedEnabled: boolean;
      websiteEmbedToken: string | null;
      websiteEmbedAllowedOrigins: string[];
      websiteEmbedLauncherLabel: string;
      websiteEmbedLauncherIcon: WorkspaceRecord["websiteEmbedLauncherIcon"];
      websiteEmbedLauncherPosition: WorkspaceRecord["websiteEmbedLauncherPosition"];
    },
  ): Promise<WorkspaceRecord> {
    const item = this.items.get(workspaceId);
    if (!item) {
      throw new Error(`Workspace ${workspaceId} not found`);
    }
    const updated = {
      ...item,
      anonymousChatEnabled: input.anonymousChatEnabled,
      anonymousChatToken: input.anonymousChatToken,
      anonymousRateLimit: input.anonymousRateLimit,
      assistantName: input.assistantName,
      greetingInstruction: input.greetingInstruction,
      assistantDefaultLocale: input.assistantDefaultLocale,
      proactiveGreetingEnabled: input.proactiveGreetingEnabled,
      websiteEmbedEnabled: input.websiteEmbedEnabled,
      websiteEmbedToken: input.websiteEmbedToken,
      websiteEmbedAllowedOrigins: input.websiteEmbedAllowedOrigins,
      websiteEmbedLauncherLabel: input.websiteEmbedLauncherLabel,
      websiteEmbedLauncherIcon: input.websiteEmbedLauncherIcon,
      websiteEmbedLauncherPosition: input.websiteEmbedLauncherPosition,
      updatedAt: new Date(),
    };
    this.items.set(workspaceId, updated);
    return updated;
  }

  async deleteById(workspaceId: string): Promise<boolean> {
    return this.items.delete(workspaceId);
  }
}

export class InMemoryBootstrapGreetingCacheRepository implements BootstrapGreetingCacheRepositoryPort {
  readonly items = new Map<string, BootstrapGreetingCacheRecord>();

  async findByWorkspaceAndFingerprint(workspaceId: string, fingerprint: string): Promise<BootstrapGreetingCacheRecord | null> {
    return this.items.get(`${workspaceId}:${fingerprint}`) ?? null;
  }

  async save(input: {
    workspaceId: string;
    fingerprint: string;
    localeUsed: string | null;
    greetingText: string;
  }): Promise<BootstrapGreetingCacheRecord> {
    const key = `${input.workspaceId}:${input.fingerprint}`;
    const existing = this.items.get(key);
    const record: BootstrapGreetingCacheRecord = {
      id: existing?.id ?? randomUUID(),
      workspaceId: input.workspaceId,
      fingerprint: input.fingerprint,
      localeUsed: input.localeUsed,
      greetingText: input.greetingText,
      createdAt: existing?.createdAt ?? new Date(),
      updatedAt: new Date(),
    };
    this.items.set(key, record);
    return record;
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
      conversationMode: input.conversationMode,
      suggestedQuestionsEnabled: input.suggestedQuestionsEnabled,
      suggestedQuestionsCount: input.suggestedQuestionsCount,
      rerankEnabled: input.rerankEnabled,
      vectorTopK: input.vectorTopK,
      similarityThreshold: input.similarityThreshold,
      rerankTopK: input.rerankTopK,
      citationDisplayEnabled: input.citationDisplayEnabled,
      answerSupportValidationEnabled: input.answerSupportValidationEnabled ?? true,
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

    return [];
  }

  private key(workspaceId: string, connectorId: string): string {
    return `${workspaceId}:${connectorId}`;
  }
}

export class InMemoryDocumentRepository implements DocumentRepositoryPort {
  readonly items = new Map<string, DocumentRecord>();

  constructor(private jobRepository?: InMemoryDocumentProcessingJobRepository) {}

  setJobRepository(jobRepository: InMemoryDocumentProcessingJobRepository): void {
    this.jobRepository = jobRepository;
  }

  async summarizeWorkspace(workspaceId: string) {
    const documents = [...this.items.values()].filter((item) => item.workspaceId === workspaceId);
    const sampleDocuments = documents.filter((item) => item.metadata.sampleDocument === true);

    return {
      documentCount: documents.length,
      readyDocumentCount: documents.filter((item) => item.status === "ready").length,
      pendingDocumentCount: documents.filter((item) => item.status === "queued" || item.status === "processing").length,
      sampleDocumentCount: sampleDocuments.length,
      sampleDocumentSlugs: sampleDocuments
        .map((item) => item.metadata.sampleSlug)
        .filter((value): value is string => typeof value === "string"),
    };
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

  async requeueAllEligibleAndQueue(workspaceId: string): Promise<{
    queuedDocumentCount: number;
    skippedDocumentCount: number;
    queuedDocuments: Array<{ documentId: string; revision: number }>;
  }> {
    const documents = [...this.items.values()].filter((item) => item.workspaceId === workspaceId);
    let queuedDocumentCount = 0;
    let skippedDocumentCount = 0;
    const queuedDocuments: Array<{ documentId: string; revision: number }> = [];

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
      queuedDocuments.push({
        documentId: record.id,
        revision: record.revision,
      });
    }

    return {
      queuedDocumentCount,
      skippedDocumentCount,
      queuedDocuments,
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

  async findById(jobId: string): Promise<DocumentProcessingJobRecord | null> {
    return this.items.get(jobId) ?? null;
  }

  async findByDocumentRevision(input: {
    documentId: string;
    workspaceId: string;
    documentRevision: number;
  }): Promise<DocumentProcessingJobRecord | null> {
    return [...this.items.values()]
      .filter((item) =>
        item.documentId === input.documentId
        && item.workspaceId === input.workspaceId
        && item.documentRevision === input.documentRevision)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null;
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

  async claimById(jobId: string, now: Date = new Date()): Promise<DocumentProcessingJobRecord | null> {
    const existing = this.items.get(jobId);
    if (!existing || existing.status !== "queued" || existing.availableAt > now) {
      return null;
    }

    const claimed: DocumentProcessingJobRecord = {
      ...existing,
      status: "processing",
      attemptCount: existing.attemptCount + 1,
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

  async releaseTimedOutClaim(jobId: string, claimedAtOrBefore: Date, errorMessage: string): Promise<boolean> {
    const existing = this.items.get(jobId);
    if (!existing || existing.status !== "processing" || !existing.claimedAt || existing.claimedAt > claimedAtOrBefore) {
      return false;
    }

    this.update(jobId, {
      status: "queued",
      lastError: errorMessage,
      availableAt: new Date(),
      claimedAt: null,
    });

    return true;
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
  private messageRepository: InMemoryMessageRepository | null = null;

  setMessageRepository(messageRepository: InMemoryMessageRepository): void {
    this.messageRepository = messageRepository;
  }

  async create(
    workspaceId: string,
    sourceChannel: string | null = null,
    anonymousSessionId: string | null = null,
    sourceOrigin: string | null = null,
  ): Promise<ConversationRecord> {
    const record: ConversationRecord = {
      id: randomUUID(),
      workspaceId,
      sourceChannel,
      sourceOrigin,
      anonymousSessionId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.items.set(record.id, record);
    return record;
  }

  async createWithInitialAssistantMessage(input: {
    workspaceId: string;
    sourceChannel?: string | null;
    anonymousSessionId?: string | null;
    sourceOrigin?: string | null;
    content: string;
  }): Promise<{ conversation: ConversationRecord; assistantMessage: MessageRecord }> {
    const conversation = await this.create(
      input.workspaceId,
      input.sourceChannel ?? null,
      input.anonymousSessionId ?? null,
      input.sourceOrigin ?? null,
    );
    const assistantMessage: MessageRecord = {
      id: randomUUID(),
      conversationId: conversation.id,
      workspaceId: input.workspaceId,
      role: "assistant",
      content: input.content,
      createdAt: new Date(),
    };

    if (this.messageRepository) {
      const existing = this.messageRepository.items.get(conversation.id) ?? [];
      this.messageRepository.items.set(conversation.id, [...existing, assistantMessage]);
    }

    return { conversation, assistantMessage };
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

  async countByWorkspaceId(workspaceId: string): Promise<number> {
    return [...this.items.values()].filter((item) => item.workspaceId === workspaceId).length;
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

  async listRecentByConversationId(workspaceId: string, conversationId: string, limit: number): Promise<MessageRecord[]> {
    return [...(this.items.get(conversationId) ?? [])]
      .filter((message) => message.workspaceId === workspaceId)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .slice(-limit);
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
    inputMetadata?: MessageRecord["inputMetadata"];
  }): Promise<MessageRecord> {
    const record: MessageRecord = {
      id: randomUUID(),
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      role: input.role,
      content: input.content,
      inputMetadata: input.inputMetadata,
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

  async findLatestChatAnswerEventByConversationId(
    workspaceId: string,
    conversationId: string,
    status?: "success" | "failure",
  ): Promise<AuditEventRecord | null> {
    const matches = this.items
      .filter((event) => {
        return (
          event.workspaceId === workspaceId &&
          event.eventType === "chat.answer" &&
          event.metadata.conversationId === conversationId &&
          (!status || event.eventStatus === status)
        );
      })
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id));

    return matches[0] ?? null;
  }

  async updateChatAnswerSuggestions(input: {
    workspaceId: string;
    conversationId: string;
    assistantMessageId: string;
    suggestions: unknown[];
    conversationModeMetadata: unknown;
  }): Promise<boolean> {
    const match = this.items
      .filter((event) => {
        return (
          event.workspaceId === input.workspaceId &&
          event.eventType === "chat.answer" &&
          event.eventStatus === "success" &&
          event.metadata.conversationId === input.conversationId &&
          event.metadata.assistantMessageId === input.assistantMessageId
        );
      })
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id))[0];

    if (!match) {
      return false;
    }

    match.metadata = {
      ...match.metadata,
      suggestions: input.suggestions,
      conversationModeMetadata: input.conversationModeMetadata,
    };

    return true;
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

export class InMemoryHistoryItemsRepository implements HistoryItemsRepositoryPort {
  constructor(
    private readonly conversationRepository: InMemoryConversationRepository,
    private readonly auditEventRepository: InMemoryAuditEventRepository,
  ) {}

  async listPageByWorkspaceId(
    workspaceId: string,
    input: { limit: number; offset?: number } = { limit: 50, offset: 0 },
  ): Promise<{ items: HistoryItemsSourceRecord[]; total: number; hasMore: boolean }> {
    const offset = input.offset ?? 0;
    const conversations: HistoryItemsSourceRecord[] = [...this.conversationRepository.items.values()]
      .filter((conversation) => conversation.workspaceId === workspaceId)
      .map((conversation) => ({
        kind: "chat" as const,
        id: conversation.id,
        sortAt: conversation.updatedAt,
        conversation,
      }));
    const searches: HistoryItemsSourceRecord[] = this.auditEventRepository.items
      .filter((event) => event.workspaceId === workspaceId && event.eventType === "document.search")
      .map((event) => ({
        kind: "search" as const,
        id: typeof event.metadata.searchId === "string" ? event.metadata.searchId : event.id,
        sortAt: event.createdAt,
        event,
      }));
    const items = [...conversations, ...searches].sort((left, right) => {
      const timeDiff = right.sortAt.getTime() - left.sortAt.getTime();
      return timeDiff !== 0 ? timeDiff : right.id.localeCompare(left.id);
    });
    const pageItems = items.slice(offset, offset + input.limit);

    return {
      items: pageItems,
      total: items.length,
      hasMore: offset + pageItems.length < items.length,
    };
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
