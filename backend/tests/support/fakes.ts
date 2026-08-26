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
import type { AccessGrantRepositoryPort } from "../../src/db/repositories/accessGrantRepository.js";
import type {
  AccessGrant,
  AccessGrantChannel,
  AccessGrantRole,
  GrantPrincipalKind,
  OriginConstraint,
} from "../../src/modules/accessGrants/public.js";
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
import type { AgentRepositoryPort } from "../../src/db/repositories/agentRepository.js";
import type {
  DocumentOriginKind,
  DocumentSourceRecord,
  DocumentSourceRepositoryPort,
} from "../../src/db/repositories/documentSourceRepository.js";
import {
  mergeAgentSurfaceSettings,
  validateAgentInput,
  authoredDirectiveInputSchema,
  type AgentInput,
  type AgentRecord,
  type AgentSkillSettingsRegistry,
  type AuthoredDirective,
  type AuthoredDirectiveInput,
} from "../../src/modules/agents/public.js";
import type {
  BootstrapGreetingCacheRecord,
  BootstrapGreetingCacheRepositoryPort,
} from "../../src/db/repositories/bootstrapGreetingCacheRepository.js";
import type { AbuseControlEntry, AbuseControlRepositoryPort } from "../../src/db/repositories/abuseControlRepository.js";
import type {
  WorkspaceProviderCredentialRecord,
  WorkspaceProviderCredentialSummary,
  WorkspaceProviderCredentialsRepositoryPort,
} from "../../src/db/repositories/workspaceProviderCredentialsRepository.js";
import type {
  WebhookDestinationRecord,
  WebhookDestinationRepositoryPort,
} from "../../src/modules/webhooks/public.js";
import type {
  WorkspaceLlmCapability,
  WorkspaceLlmCapabilityPreference,
  WorkspaceLlmCapabilityPreferenceInput,
} from "../../src/modules/settings/contracts/llmCapability.js";
import {
  routineDefinitionDraftInputSchema,
  type RoutineDefinition,
  type RoutineDefinitionDraftInput,
  type RoutineDefinitionRepositoryPort,
} from "../../src/modules/routines/public.js";
import type { LlmProviderName } from "../../src/shared/infra/llm/providerTypes.js";
import type {
  EmailVerificationTokenRecord,
  EmailVerificationTokenRepositoryPort,
} from "../../src/db/repositories/emailVerificationTokenRepository.js";
import type {
  PasswordResetTokenRecord,
  PasswordResetTokenRepositoryPort,
} from "../../src/db/repositories/passwordResetTokenRepository.js";
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
  WorkspaceCanonicalEmbeddingCoverage,
} from "../../src/modules/embeddingProfiles/contracts/embeddingCoverage.js";
import type { DocumentProcessingJobOptions } from "../../src/modules/documents/contracts/documentContracts.js";
import type {
  ConversationRecord,
  ConversationRepositoryPort,
  GetOrCreateConversationResult,
} from "../../src/db/repositories/conversationRepository.js";
import type { ConversationSourceScope } from "../../src/shared/domain/conversationSource.js";
import type { ConversationOwnershipScope } from "../../src/modules/handoff/ownershipState.js";
import type {
  ConversationOwnershipHandBackInput,
  ConversationOwnershipMutationResult,
  ConversationOwnershipRecord,
  ConversationOwnershipRepository,
  ConversationOwnershipRequestHandoffInput,
  ConversationOwnershipRequestHandoffResult,
  ConversationOwnershipTakeOverInput,
  ConversationOwnershipTransferInput,
} from "../../src/db/repositories/conversationOwnershipRepository.js";
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
import type { MessageSource } from "@radioso/conversation-contract";
import { deriveMessageSourceFromRole } from "../../src/db/repositories/messageRepository.js";
import type {
  IngestionSettingsRecord,
  ValidatedIngestionSettingsInput,
} from "../../src/modules/settings/contracts/ingestion.js";
import {
  inferMetadataValueType,
  type MetadataFieldSuggestion,
  type MetadataValueType,
} from "../../src/modules/settings/contracts/retrieval.js";
import type {
  IngestionSettingsRepositoryPort,
  WorkspaceLlmCapabilityPreferencesRepositoryPort,
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
import {
  DEFAULT_DOCUMENT_TYPE_CATALOG_REVISION,
  type DocumentTypeCatalogRecord,
  type DocumentTypeCatalogRepositoryPort,
  type OperatorDocumentTypeDefinition,
  type RetiredDocumentTypeFieldIdentity,
} from "../../src/modules/documentTypes/contracts/documentTypeCatalog.js";
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

interface InMemoryConnectorSyncStateRecord {
  workspaceId: string;
  connectorId: string;
  backfillCompletedAt: Date | null;
  syncRequestedAt: Date | null;
  syncStartedAt: Date | null;
  syncLockToken: string | null;
  lastRunAt: Date | null;
  lastModifiedAt: Date | null;
  lastIngestedCount: number | null;
  lastError: string | null;
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

export class InMemoryAccessGrantRepository implements AccessGrantRepositoryPort {
  readonly items: AccessGrant[] = [];

  async findById(grantId: string): Promise<AccessGrant | null> {
    return this.items.find((item) => item.id === grantId) ?? null;
  }

  async findByTokenHash(tokenHash: string): Promise<AccessGrant | null> {
    return this.items.find((item) => item.tokenHash === tokenHash) ?? null;
  }

  async listByAgent(agentId: string): Promise<AccessGrant[]> {
    return this.items.filter((item) => item.agentId === agentId);
  }

  async save(params: {
    agentId: string;
    workspaceId: string;
    label?: string | null;
    principalKind: GrantPrincipalKind;
    role: AccessGrantRole;
    channel?: AccessGrantChannel;
    tokenPrefix: string;
    tokenHash: string;
    encryptedToken: string;
    originConstraint: OriginConstraint;
    enabled?: boolean;
    expiresAt?: Date | null;
  }): Promise<AccessGrant> {
    const existing = await this.findByTokenHash(params.tokenHash);
    if (existing) {
      return existing;
    }
    const now = new Date();
    const grant: AccessGrant = {
      id: randomUUID(),
      agentId: params.agentId,
      workspaceId: params.workspaceId,
      label: params.label ?? null,
      principalKind: params.principalKind,
      role: params.role,
      channel: params.channel ?? "public-link",
      tokenPrefix: params.tokenPrefix,
      tokenHash: params.tokenHash,
      encryptedToken: params.encryptedToken,
      originConstraint: params.originConstraint,
      enabled: params.enabled ?? true,
      expiresAt: params.expiresAt ?? null,
      createdAt: now,
      lastUsedAt: null,
      revokedAt: null,
    };
    this.items.push(grant);
    return grant;
  }

  async rotate(grantId: string, params: {
    tokenPrefix: string;
    tokenHash: string;
    encryptedToken: string;
  }): Promise<AccessGrant | null> {
    const grant = await this.findById(grantId);
    if (!grant) {
      return null;
    }
    grant.tokenPrefix = params.tokenPrefix;
    grant.tokenHash = params.tokenHash;
    grant.encryptedToken = params.encryptedToken;
    grant.lastUsedAt = null;
    grant.revokedAt = null;
    return grant;
  }

  async revoke(grantId: string, revokedAt: Date): Promise<AccessGrant | null> {
    const grant = await this.findById(grantId);
    if (!grant) {
      return null;
    }
    grant.revokedAt = revokedAt;
    return grant;
  }

  async touch(grantId: string, lastUsedAt: Date): Promise<void> {
    const grant = await this.findById(grantId);
    if (grant && !grant.revokedAt) {
      grant.lastUsedAt = lastUsedAt;
    }
  }

  async updateConstraints(grantId: string, params: {
    originConstraint?: OriginConstraint;
    enabled?: boolean;
    label?: string | null;
  }): Promise<AccessGrant | null> {
    const grant = await this.findById(grantId);
    if (!grant) {
      return null;
    }
    grant.originConstraint = params.originConstraint ?? grant.originConstraint;
    grant.enabled = params.enabled ?? grant.enabled;
    grant.label = params.label === undefined ? grant.label : params.label;
    return grant;
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
      createdAt: new Date(Date.now() + this.items.size),
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

export class InMemoryPasswordResetTokenRepository implements PasswordResetTokenRepositoryPort {
  readonly items = new Map<string, PasswordResetTokenRecord>();

  async create(params: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    requestIp?: string | null;
    requestUserAgent?: string | null;
  }): Promise<PasswordResetTokenRecord> {
    const record: PasswordResetTokenRecord = {
      id: randomUUID(),
      userId: params.userId,
      tokenHash: params.tokenHash,
      expiresAt: params.expiresAt,
      usedAt: null,
      createdAt: new Date(Date.now() + this.items.size),
    };
    this.items.set(record.id, record);
    return record;
  }

  async findByTokenHash(tokenHash: string): Promise<PasswordResetTokenRecord | null> {
    return [...this.items.values()].find((item) => item.tokenHash === tokenHash) ?? null;
  }

  async findLatestActiveForUser(userId: string, now: Date): Promise<PasswordResetTokenRecord | null> {
    return [...this.items.values()]
      .filter((item) => item.userId === userId && !item.usedAt && item.expiresAt > now)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null;
  }

  async markUsed(id: string, usedAt: Date): Promise<number> {
    const existing = this.items.get(id);
    if (existing && !existing.usedAt) {
      this.items.set(id, { ...existing, usedAt });
      return 1;
    }
    return 0;
  }

  async markAllActiveUsedForUser(userId: string, usedAt: Date): Promise<number> {
    let count = 0;
    for (const item of this.items.values()) {
      if (item.userId === userId && !item.usedAt && item.expiresAt > usedAt) {
        this.items.set(item.id, { ...item, usedAt });
        count += 1;
      }
    }
    return count;
  }
}

export class InMemoryEmailVerificationTokenRepository implements EmailVerificationTokenRepositoryPort {
  readonly items = new Map<string, EmailVerificationTokenRecord>();

  async create(params: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    requestIp?: string | null;
    requestUserAgent?: string | null;
  }): Promise<EmailVerificationTokenRecord> {
    const record: EmailVerificationTokenRecord = {
      id: randomUUID(),
      userId: params.userId,
      tokenHash: params.tokenHash,
      expiresAt: params.expiresAt,
      usedAt: null,
      createdAt: new Date(),
    };
    this.items.set(record.id, record);
    return record;
  }

  async findByTokenHash(tokenHash: string): Promise<EmailVerificationTokenRecord | null> {
    return [...this.items.values()].find((item) => item.tokenHash === tokenHash) ?? null;
  }

  async findLatestActiveForUser(userId: string, now: Date): Promise<EmailVerificationTokenRecord | null> {
    return [...this.items.values()]
      .filter((item) => item.userId === userId && !item.usedAt && item.expiresAt > now)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null;
  }

  async markUsed(id: string, usedAt: Date): Promise<void> {
    const existing = this.items.get(id);
    if (existing && !existing.usedAt) {
      this.items.set(id, { ...existing, usedAt });
    }
  }

  async markAllActiveUsedForUser(userId: string, usedAt: Date): Promise<number> {
    let count = 0;
    for (const item of this.items.values()) {
      if (item.userId === userId && !item.usedAt && item.expiresAt > usedAt) {
        this.items.set(item.id, { ...item, usedAt });
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

  async findById(id: string): Promise<AccountInvitationRecord | null> {
    return this.items.get(id) ?? null;
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

  async updateIfStatus(params: {
    id: string;
    currentStatus: AccountInvitationStatus;
    status: AccountInvitationStatus;
    acceptedAt?: Date | null;
    acceptedByUserId?: string | null;
  }): Promise<AccountInvitationRecord | null> {
    const existing = this.items.get(params.id);
    if (!existing || existing.status !== params.currentStatus) {
      return null;
    }

    return this.update(params);
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

export class InMemoryWorkspaceTokenRepository implements WorkspaceTokenRepositoryPort {
  private readonly items = new Map<string, WorkspaceTokenRecord>();

  async findByWorkspaceId(workspaceId: string): Promise<WorkspaceTokenRecord | null> {
    return [...this.items.values()].find((item) => item.workspaceId === workspaceId && item.revokedAt === null) ?? null;
  }

  async findByTokenHash(tokenHash: string): Promise<WorkspaceTokenRecord | null> {
    return [...this.items.values()].find((item) => item.tokenHash === tokenHash && item.revokedAt === null) ?? null;
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
      revokedAt: null,
    };

    this.items.set(record.id, record);
    return record;
  }

  async touch(workspaceId: string, lastUsedAt: Date): Promise<void> {
    const item = [...this.items.values()].find((i) => i.workspaceId === workspaceId && i.revokedAt === null);
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
      defaultAgentId: null,
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
      websiteEmbedLauncherPosition: "bottom-right",
      websiteEmbedTheme: {
        brand: "#0f172a",
        brandText: "#f8fafc",
        surface: "#ffffff",
        text: "#0f172a",
      },
      websiteEmbedCopy: {},
      websiteEmbedExpertOverrides: {},
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

  async updateName(workspaceId: string, accountId: string, name: string): Promise<WorkspaceRecord> {
    const item = this.items.get(workspaceId);
    if (!item || item.accountId !== accountId) {
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
      assistantName: string;
      greetingInstruction: string;
      assistantDefaultLocale: string | null;
      proactiveGreetingEnabled: boolean;
      websiteEmbedEnabled: boolean;
      websiteEmbedToken: string | null;
      websiteEmbedAllowedOrigins: string[];
      websiteEmbedLauncherLabel: string;
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
      assistantName: input.assistantName,
      greetingInstruction: input.greetingInstruction,
      assistantDefaultLocale: input.assistantDefaultLocale,
      proactiveGreetingEnabled: input.proactiveGreetingEnabled,
      websiteEmbedEnabled: input.websiteEmbedEnabled,
      websiteEmbedToken: input.websiteEmbedToken,
      websiteEmbedAllowedOrigins: input.websiteEmbedAllowedOrigins,
      websiteEmbedLauncherLabel: input.websiteEmbedLauncherLabel,
      websiteEmbedLauncherPosition: input.websiteEmbedLauncherPosition,
      updatedAt: new Date(),
    };
    this.items.set(workspaceId, updated);
    return updated;
  }

  async deleteByIdAndAccountId(workspaceId: string, accountId: string): Promise<boolean> {
    const item = this.items.get(workspaceId);
    if (!item || item.accountId !== accountId) {
      return false;
    }
    return this.items.delete(workspaceId);
  }
}

export class InMemoryAgentRepository implements AgentRepositoryPort {
  readonly items = new Map<string, AgentRecord>();
  readonly directives = new Map<string, AuthoredDirective>();
  private defaultAgentIds = new Map<string, string>();

  constructor(private readonly skillSettings?: AgentSkillSettingsRegistry) {}

  async create(workspaceId: string, input: AgentInput): Promise<AgentRecord> {
    const normalized = validateAgentInput(input, { skillSettings: this.skillSettings });
    const record: AgentRecord = {
      id: randomUUID(),
      workspaceId,
      ...normalized,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.items.set(record.id, record);
    if (!this.defaultAgentIds.has(workspaceId)) {
      this.defaultAgentIds.set(workspaceId, record.id);
    }
    return record;
  }

  async findByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<AgentRecord | null> {
    const item = this.items.get(agentId);
    return item && item.workspaceId === workspaceId ? item : null;
  }

  async findDefaultByWorkspaceId(workspaceId: string): Promise<AgentRecord | null> {
    const agentId = this.defaultAgentIds.get(workspaceId);
    return agentId ? this.findByIdAndWorkspaceId(agentId, workspaceId) : null;
  }

  async findByAnonymousChatToken(token: string): Promise<AgentRecord | null> {
    return [...this.items.values()].find((item) => item.surfaceSettings.anonymousChat.token === token) ?? null;
  }

  async findByWebsiteEmbedToken(token: string): Promise<AgentRecord | null> {
    return [...this.items.values()].find((item) => item.surfaceSettings.websiteEmbed.token === token) ?? null;
  }

  async listByWorkspaceId(workspaceId: string): Promise<AgentRecord[]> {
    return [...this.items.values()]
      .filter((item) => item.workspaceId === workspaceId)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id));
  }

  async listDirectives(agentId: string, workspaceId: string): Promise<AuthoredDirective[]> {
    const agent = await this.findByIdAndWorkspaceId(agentId, workspaceId);
    if (!agent) {
      return [];
    }
    return [...this.directives.values()]
      .filter((directive) => directive.agentId === agentId)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id));
  }

  async createDirective(agentId: string, workspaceId: string, input: AuthoredDirectiveInput): Promise<AuthoredDirective> {
    const agent = await this.findByIdAndWorkspaceId(agentId, workspaceId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }
    const normalized = authoredDirectiveInputSchema.parse(input);
    this.throwDirectiveNameConflict(agentId, normalized.name);
    const now = new Date();
    const directive: AuthoredDirective = {
      id: randomUUID(),
      agentId,
      ...normalized,
      createdAt: now,
      updatedAt: now,
    };
    this.directives.set(directive.id, directive);
    agent.authoredDirectives = await this.listDirectives(agentId, workspaceId);
    return directive;
  }

  async updateDirective(
    agentId: string,
    workspaceId: string,
    directiveId: string,
    input: Partial<AuthoredDirectiveInput>,
  ): Promise<AuthoredDirective> {
    const existing = this.directives.get(directiveId);
    const agent = await this.findByIdAndWorkspaceId(agentId, workspaceId);
    if (!existing || !agent || existing.agentId !== agentId) {
      throw new Error(`Directive ${directiveId} not found`);
    }
    const normalized = authoredDirectiveInputSchema.parse({
      name: input.name ?? existing.name,
      condition: input.condition ?? existing.condition,
      action: input.action ?? existing.action,
      priority: Object.prototype.hasOwnProperty.call(input, "priority") ? input.priority : existing.priority,
      requiredCapabilities: input.requiredCapabilities ?? existing.requiredCapabilities,
      dependsOn: input.dependsOn ?? existing.dependsOn,
      excludes: input.excludes ?? existing.excludes,
      routes: input.routes ?? existing.routes,
      tags: input.tags ?? existing.tags,
      description: input.description ?? existing.description,
      binding: Object.prototype.hasOwnProperty.call(input, "binding") ? input.binding : existing.binding,
      metadata: input.metadata ?? existing.metadata,
    });
    this.throwDirectiveNameConflict(agentId, normalized.name, directiveId);
    const updated: AuthoredDirective = {
      ...existing,
      ...normalized,
      updatedAt: new Date(),
    };
    this.directives.set(directiveId, updated);
    agent.authoredDirectives = await this.listDirectives(agentId, workspaceId);
    return updated;
  }

  private throwDirectiveNameConflict(agentId: string, name: string, excludeDirectiveId?: string): void {
    const duplicate = [...this.directives.values()].some((directive) =>
      directive.agentId === agentId &&
      directive.name === name &&
      directive.id !== excludeDirectiveId
    );
    if (duplicate) {
      throw conflict(`A directive named "${name}" already exists for this agent.`);
    }
  }

  async deleteDirective(agentId: string, workspaceId: string, directiveId: string): Promise<boolean> {
    const agent = await this.findByIdAndWorkspaceId(agentId, workspaceId);
    const existing = this.directives.get(directiveId);
    if (!agent || !existing || existing.agentId !== agentId) {
      return false;
    }
    const deleted = this.directives.delete(directiveId);
    agent.authoredDirectives = await this.listDirectives(agentId, workspaceId);
    return deleted;
  }

  async repointRoutineScopeTags(input: {
    agentId: string;
    fromDefinitionId: string;
    toDefinitionId: string;
    survivingStepIds: ReadonlySet<string>;
  }): Promise<{ repointed: number; orphans: Array<{ directiveId: string; scopeTag: string; reason: "missing_step" }> }> {
    const routineTag = `routine:${input.fromDefinitionId}`;
    const stepTagPrefix = `step:${input.fromDefinitionId}:`;
    let repointed = 0;
    const orphans: Array<{ directiveId: string; scopeTag: string; reason: "missing_step" }> = [];
    for (const directive of this.directives.values()) {
      if (directive.agentId !== input.agentId) {
        continue;
      }
      let changed = false;
      const tags = directive.tags.map((tag) => {
        if (tag === routineTag) {
          changed = true;
          repointed += 1;
          return `routine:${input.toDefinitionId}`;
        }
        if (!tag.startsWith(stepTagPrefix)) {
          return tag;
        }
        const stepId = tag.slice(stepTagPrefix.length);
        if (!input.survivingStepIds.has(stepId)) {
          orphans.push({ directiveId: directive.id, scopeTag: tag, reason: "missing_step" });
          return tag;
        }
        changed = true;
        repointed += 1;
        return `step:${input.toDefinitionId}:${stepId}`;
      });
      if (changed) {
        this.directives.set(directive.id, {
          ...directive,
          tags,
          updatedAt: new Date(),
        });
      }
    }
    return { repointed, orphans };
  }

  async update(agentId: string, workspaceId: string, input: AgentInput): Promise<AgentRecord> {
    const current = await this.findByIdAndWorkspaceId(agentId, workspaceId);
    if (!current) {
      throw new Error(`Agent ${agentId} not found`);
    }
    const normalized = validateAgentInput({
      ...current,
      ...input,
      surfaceSettings: mergeAgentSurfaceSettings(current.surfaceSettings, input.surfaceSettings),
    }, { skillSettings: this.skillSettings });
    const updated: AgentRecord = {
      ...current,
      ...normalized,
      updatedAt: new Date(),
    };
    this.items.set(agentId, updated);
    return updated;
  }

  async setDefault(workspaceId: string, agentId: string): Promise<void> {
    const agent = await this.findByIdAndWorkspaceId(agentId, workspaceId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }
    this.defaultAgentIds.set(workspaceId, agentId);
  }

  async deleteByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<boolean> {
    const agent = await this.findByIdAndWorkspaceId(agentId, workspaceId);
    if (!agent) {
      return false;
    }
    this.items.delete(agentId);
    if (this.defaultAgentIds.get(workspaceId) === agentId) {
      this.defaultAgentIds.delete(workspaceId);
    }
    return true;
  }

  async countByWorkspaceId(workspaceId: string): Promise<number> {
    let count = 0;
    for (const item of this.items.values()) {
      if (item.workspaceId === workspaceId) {
        count += 1;
      }
    }
    return count;
  }
}

export class InMemoryRoutineDefinitionRepository implements RoutineDefinitionRepositoryPort {
  readonly items = new Map<string, RoutineDefinition>();

  async listPublishedByAgent(agentId: string): Promise<RoutineDefinition[]> {
    return [...this.items.values()]
      .filter((definition) => definition.agentId === agentId && definition.status === "published")
      .sort((left, right) =>
        right.activation.priority - left.activation.priority ||
        left.createdAt.getTime() - right.createdAt.getTime() ||
        left.id.localeCompare(right.id)
      );
  }

  async listByAgent(agentId: string): Promise<RoutineDefinition[]> {
    return [...this.items.values()]
      .filter((definition) => definition.agentId === agentId)
      .sort((left, right) =>
        left.status.localeCompare(right.status) ||
        left.name.localeCompare(right.name) ||
        left.version - right.version ||
        left.createdAt.getTime() - right.createdAt.getTime() ||
        left.id.localeCompare(right.id)
      );
  }

  async findById(agentId: string, id: string): Promise<RoutineDefinition | null> {
    const item = this.items.get(id);
    return item && item.agentId === agentId ? item : null;
  }

  async findPinnedById(agentId: string, id: string): Promise<RoutineDefinition | null> {
    const item = await this.findById(agentId, id);
    return item && item.status !== "draft" ? item : null;
  }

  async createDraft(agentId: string, input: RoutineDefinitionDraftInput): Promise<RoutineDefinition> {
    const draft = routineDefinitionDraftInputSchema.parse(input);
    const now = new Date();
    const definition: RoutineDefinition = {
      id: randomUUID(),
      agentId,
      lineageId: randomUUID(),
      version: 1,
      status: "draft",
      ...draft,
      createdAt: now,
      updatedAt: now,
    };
    this.items.set(definition.id, definition);
    return definition;
  }

  async updateDraft(agentId: string, id: string, input: RoutineDefinitionDraftInput): Promise<RoutineDefinition> {
    const existing = await this.findById(agentId, id);
    if (existing && existing.status !== "draft") {
      // Mirrors the SQL repository's zero-row guard for a save racing publish.
      throw new Error(`routine_definition_update_conflict:${id}`);
    }
    if (!existing) {
      throw new Error(`Routine definition ${id} not found`);
    }
    const draft = routineDefinitionDraftInputSchema.parse(input);
    const updated: RoutineDefinition = {
      ...existing,
      ...draft,
      updatedAt: new Date(),
    };
    this.items.set(id, updated);
    return updated;
  }

  async publish(agentId: string, draftId: string): Promise<RoutineDefinition> {
    const draft = await this.findById(agentId, draftId);
    if (!draft || draft.status !== "draft") {
      throw new Error(`Routine definition ${draftId} not found`);
    }
    const now = new Date();
    for (const definition of this.items.values()) {
      if (
        definition.agentId === agentId &&
        definition.lineageId === draft.lineageId &&
        definition.status === "published"
      ) {
        this.items.set(definition.id, {
          ...definition,
          status: "superseded",
          updatedAt: now,
        });
      }
    }
    const published: RoutineDefinition = {
      ...draft,
      status: "published",
      updatedAt: now,
    };
    this.items.set(draftId, published);
    return published;
  }

  async createRevisionDraft(agentId: string, publishedId: string): Promise<RoutineDefinition | null> {
    const published = await this.findById(agentId, publishedId);
    if (!published || published.status !== "published") {
      return null;
    }
    const existingDraft = [...this.items.values()].find((definition) =>
      definition.agentId === agentId &&
      definition.lineageId === published.lineageId &&
      definition.status === "draft"
    );
    if (existingDraft) {
      return existingDraft;
    }
    const now = new Date();
    const draft: RoutineDefinition = {
      ...published,
      id: randomUUID(),
      version: Math.max(
        0,
        ...[...this.items.values()]
          .filter((definition) => definition.agentId === agentId && definition.lineageId === published.lineageId)
          .map((definition) => definition.version),
      ) + 1,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };
    this.items.set(draft.id, draft);
    return draft;
  }

  async archive(agentId: string, id: string): Promise<boolean> {
    const existing = await this.findById(agentId, id);
    if (!existing || existing.status !== "published") {
      return false;
    }
    for (const definition of [...this.items.values()]) {
      if (
        definition.agentId === agentId &&
        definition.lineageId === existing.lineageId &&
        definition.status === "draft"
      ) {
        this.items.delete(definition.id);
      }
    }
    this.items.set(id, {
      ...existing,
      status: "archived",
      updatedAt: new Date(),
    });
    return true;
  }

  async restore(agentId: string, id: string): Promise<boolean> {
    const existing = await this.findById(agentId, id);
    if (!existing || existing.status !== "archived") {
      return false;
    }
    const hasPublished = [...this.items.values()].some((definition) =>
      definition.agentId === agentId &&
      definition.lineageId === existing.lineageId &&
      definition.status === "published"
    );
    if (hasPublished) {
      return false;
    }
    this.items.set(id, {
      ...existing,
      status: "published",
      updatedAt: new Date(),
    });
    return true;
  }

  async deleteDraft(agentId: string, id: string): Promise<boolean> {
    const existing = await this.findById(agentId, id);
    if (!existing || existing.status !== "draft") {
      return false;
    }
    return this.items.delete(id);
  }

  async listPublishedRoutineNamesReferencingDestination(
    _workspaceId: string,
    destinationId: string,
  ): Promise<string[]> {
    return [...this.items.values()]
      .filter((definition) =>
        definition.status === "published" &&
        definition.completionExport?.enabled &&
        definition.completionExport.destinationRef === destinationId
      )
      .map((definition) => definition.name)
      .sort((left, right) => left.localeCompare(right));
  }
}

export class InMemoryBootstrapGreetingCacheRepository implements BootstrapGreetingCacheRepositoryPort {
  readonly items = new Map<string, BootstrapGreetingCacheRecord>();

  async findByWorkspaceAgentAndFingerprint(
    workspaceId: string,
    agentId: string,
    fingerprint: string,
  ): Promise<BootstrapGreetingCacheRecord | null> {
    return this.items.get(`${workspaceId}:${agentId}:${fingerprint}`) ?? null;
  }

  async findById(workspaceId: string, id: string): Promise<BootstrapGreetingCacheRecord | null> {
    return [...this.items.values()].find((item) => item.workspaceId === workspaceId && item.id === id) ?? null;
  }

  async save(input: {
    workspaceId: string;
    agentId: string;
    fingerprint: string;
    localeUsed: string | null;
    greetingText: string;
  }): Promise<BootstrapGreetingCacheRecord> {
    const key = `${input.workspaceId}:${input.agentId}:${input.fingerprint}`;
    const existing = this.items.get(key);
    const record: BootstrapGreetingCacheRecord = {
      id: existing?.id ?? randomUUID(),
      workspaceId: input.workspaceId,
      agentId: input.agentId,
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

export class InMemoryWorkspaceProviderCredentialsRepository
  implements WorkspaceProviderCredentialsRepositoryPort
{
  readonly items = new Map<string, WorkspaceProviderCredentialRecord>();

  async findByWorkspaceAndProvider(
    workspaceId: string,
    provider: LlmProviderName,
  ): Promise<WorkspaceProviderCredentialRecord | null> {
    return this.items.get(`${workspaceId}:${provider}`) ?? null;
  }

  async listByWorkspace(workspaceId: string): Promise<WorkspaceProviderCredentialSummary[]> {
    return [...this.items.values()]
      .filter((record) => record.workspaceId === workspaceId)
      .map((record) => ({
        workspaceId: record.workspaceId,
        provider: record.provider,
        updatedAt: record.updatedAt,
      }))
      .sort((a, b) => a.provider.localeCompare(b.provider));
  }

  async upsert(input: {
    workspaceId: string;
    provider: LlmProviderName;
    ciphertext: string;
  }): Promise<WorkspaceProviderCredentialRecord> {
    const key = `${input.workspaceId}:${input.provider}`;
    const existing = this.items.get(key);
    const record: WorkspaceProviderCredentialRecord = {
      workspaceId: input.workspaceId,
      provider: input.provider,
      ciphertext: input.ciphertext,
      createdAt: existing?.createdAt ?? new Date(),
      updatedAt: new Date(),
    };
    this.items.set(key, record);
    return record;
  }

  async remove(workspaceId: string, provider: LlmProviderName): Promise<boolean> {
    return this.items.delete(`${workspaceId}:${provider}`);
  }
}

export class InMemoryWebhookDestinationRepository implements WebhookDestinationRepositoryPort {
  readonly items = new Map<string, WebhookDestinationRecord>();

  async create(input: {
    workspaceId: string;
    name: string;
    url: string;
    secretCiphertext: string;
    encryptionKeyId: string;
  }): Promise<WebhookDestinationRecord> {
    const duplicate = [...this.items.values()].some((item) =>
      item.workspaceId === input.workspaceId && item.name.toLowerCase() === input.name.toLowerCase()
    );
    if (duplicate) {
      const error = new Error("duplicate key value violates unique constraint");
      (error as Error & { code: string }).code = "23505";
      throw error;
    }
    const now = new Date();
    const record: WebhookDestinationRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      name: input.name,
      url: input.url,
      secretCiphertext: input.secretCiphertext,
      encryptionKeyId: input.encryptionKeyId,
      lastDeliveryStatus: null,
      lastDeliveryAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.items.set(record.id, record);
    return record;
  }

  async listByWorkspace(workspaceId: string): Promise<WebhookDestinationRecord[]> {
    return [...this.items.values()]
      .filter((item) => item.workspaceId === workspaceId)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async findByIdAndWorkspace(id: string, workspaceId: string): Promise<WebhookDestinationRecord | null> {
    const item = this.items.get(id);
    return item && item.workspaceId === workspaceId ? item : null;
  }

  async update(
    id: string,
    workspaceId: string,
    input: { name: string; url: string },
  ): Promise<WebhookDestinationRecord | null> {
    const item = await this.findByIdAndWorkspace(id, workspaceId);
    if (!item) {
      return null;
    }
    const duplicate = [...this.items.values()].some((candidate) =>
      candidate.id !== id &&
      candidate.workspaceId === workspaceId &&
      candidate.name.toLowerCase() === input.name.toLowerCase()
    );
    if (duplicate) {
      const error = new Error("duplicate key value violates unique constraint");
      (error as Error & { code: string }).code = "23505";
      throw error;
    }
    const updated = { ...item, ...input, updatedAt: new Date() };
    this.items.set(id, updated);
    return updated;
  }

  async updateSecret(
    id: string,
    workspaceId: string,
    input: { secretCiphertext: string; encryptionKeyId: string },
  ): Promise<WebhookDestinationRecord | null> {
    const item = await this.findByIdAndWorkspace(id, workspaceId);
    if (!item) {
      return null;
    }
    const updated = { ...item, ...input, updatedAt: new Date() };
    this.items.set(id, updated);
    return updated;
  }

  async recordDeliveryOutcome(id: string, workspaceId: string, status: string): Promise<void> {
    const item = await this.findByIdAndWorkspace(id, workspaceId);
    if (!item) {
      return;
    }
    this.items.set(id, {
      ...item,
      lastDeliveryStatus: status,
      lastDeliveryAt: new Date(),
      updatedAt: new Date(),
    });
  }

  async delete(id: string, workspaceId: string): Promise<boolean> {
    const item = await this.findByIdAndWorkspace(id, workspaceId);
    return item ? this.items.delete(id) : false;
  }
}

export class InMemoryRetrievalSettingsRepository
  implements WorkspaceLlmCapabilityPreferencesRepositoryPort
{
  private readonly rows = new Set<string>();
  readonly capabilityRows = new Map<string, Map<WorkspaceLlmCapability, WorkspaceLlmCapabilityPreference>>();

  async ensureRow(workspaceId: string): Promise<void> {
    this.rows.add(workspaceId);
  }

  async findByWorkspace(workspaceId: string): Promise<WorkspaceLlmCapabilityPreference[]> {
    const row = this.capabilityRows.get(workspaceId);
    return row ? [...row.values()] : [];
  }

  async setPreference(
    workspaceId: string,
    capability: WorkspaceLlmCapability,
    value: WorkspaceLlmCapabilityPreferenceInput | null,
  ): Promise<void> {
    if (!this.rows.has(workspaceId)) {
      throw new Error(`retrieval_settings row missing for workspace ${workspaceId}`);
    }
    const row = this.capabilityRows.get(workspaceId) ?? new Map();
    if (value === null) {
      row.delete(capability);
    } else {
      row.set(capability, {
        workspaceId,
        capability,
        provider: value.provider,
        model: value.model,
        updatedAt: new Date(),
      });
    }
    this.capabilityRows.set(workspaceId, row);
  }

}

export class InMemoryIngestionSettingsRepository implements IngestionSettingsRepositoryPort {
  private readonly items = new Map<string, IngestionSettingsRecord>();
  private readonly revisions = new Map<string, bigint>();

  async findByWorkspaceId(workspaceId: string): Promise<IngestionSettingsRecord | null> {
    return this.items.get(workspaceId) ?? null;
  }

  async findVersionedByWorkspaceId(workspaceId: string): Promise<{
    settings: IngestionSettingsRecord;
    revision: string;
  } | null> {
    const settings = this.items.get(workspaceId);
    if (!settings) {
      return null;
    }
    return {
      settings,
      revision: String(this.revisions.get(workspaceId) ?? 1n),
    };
  }

  async upsert(workspaceId: string, input: ValidatedIngestionSettingsInput): Promise<IngestionSettingsRecord> {
    const existing = this.items.get(workspaceId);
    const record: IngestionSettingsRecord = {
      workspaceId,
      chunkingStrategy: input.chunkingStrategy,
      embeddingModel: input.embeddingModel,
      pendingEmbeddingModel: input.pendingEmbeddingModel,
      documentEnrichmentEnabled: input.documentEnrichmentEnabled ?? false,
      manualDocumentEnrichmentOverride: input.manualDocumentEnrichmentOverride ?? "inherit",
      fixedWindowChunkSize: input.fixedWindowChunkSize,
      fixedWindowChunkOverlap: input.fixedWindowChunkOverlap,
      structuredMinChunkSize: input.structuredMinChunkSize,
      structuredMaxChunkSize: input.structuredMaxChunkSize,
      createdAt: existing?.createdAt ?? new Date(),
      updatedAt: new Date(),
    };
    this.items.set(workspaceId, record);
    this.revisions.set(
      workspaceId,
      (this.revisions.get(workspaceId) ?? 0n) + 1n,
    );
    return record;
  }

  async clearPendingEmbeddingModel(
    workspaceId: string,
    expectedPendingEmbeddingModel: NonNullable<
      IngestionSettingsRecord["pendingEmbeddingModel"]
    >,
    expectedRevision: string,
  ): Promise<IngestionSettingsRecord | null> {
    const existing = this.items.get(workspaceId);
    const revision = this.revisions.get(workspaceId) ?? 1n;
    if (
      !existing
      || existing.pendingEmbeddingModel !== expectedPendingEmbeddingModel
      || String(revision) !== expectedRevision
    ) {
      return null;
    }
    const record = {
      ...existing,
      pendingEmbeddingModel: null,
      updatedAt: new Date(),
    };
    this.items.set(workspaceId, record);
    this.revisions.set(workspaceId, revision + 1n);
    return record;
  }

  async promotePendingEmbeddingModelIfReady(workspaceId: string): Promise<IngestionSettingsRecord | null> {
    const existing = this.items.get(workspaceId);
    if (!existing?.pendingEmbeddingModel) {
      return existing ?? null;
    }
    const record = {
      ...existing,
      embeddingModel: existing.pendingEmbeddingModel,
      pendingEmbeddingModel: null,
      updatedAt: new Date(),
    };
    this.items.set(workspaceId, record);
    this.revisions.set(
      workspaceId,
      (this.revisions.get(workspaceId) ?? 0n) + 1n,
    );
    return record;
  }
}

export class InMemoryConnectorDatabase {
  readonly configs = new Map<string, InMemoryConnectorConfigRecord>();
  readonly syncStates = new Map<string, InMemoryConnectorSyncStateRecord>();
  readonly evalSnapshots = new Map<string, Record<string, unknown>>();
  readonly evalRuns = new Map<string, Record<string, unknown>>();

  async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
    const sql = text.replace(/\s+/g, " ").trim();

    if (sql.startsWith("INSERT INTO eval_snapshots")) {
      const [
        id,
        workspaceId,
        sourceConversationId,
        sourceMessageId,
        fidelity,
        messages,
        originalInstructionBlock,
        originalModelId,
        originalRetrievalSettings,
        originalRetrievalResult,
        originalAgent,
        originalAgentConfig,
        sourceAgentId,
        capturedBy,
      ] = params as unknown[];
      const row = {
        id,
        workspace_id: workspaceId,
        source_conversation_id: sourceConversationId,
        source_message_id: sourceMessageId,
        fidelity,
        messages: typeof messages === "string" ? JSON.parse(messages) : messages,
        original_instruction_block:
          typeof originalInstructionBlock === "string" ? JSON.parse(originalInstructionBlock) : originalInstructionBlock,
        original_model_id: originalModelId,
        original_retrieval_settings:
          typeof originalRetrievalSettings === "string" ? JSON.parse(originalRetrievalSettings) : originalRetrievalSettings,
        original_retrieval_result:
          typeof originalRetrievalResult === "string" ? JSON.parse(originalRetrievalResult) : originalRetrievalResult,
        original_agent: typeof originalAgent === "string" ? JSON.parse(originalAgent) : originalAgent,
        original_agent_config:
          typeof originalAgentConfig === "string" ? JSON.parse(originalAgentConfig) : originalAgentConfig,
        source_agent_id: sourceAgentId,
        captured_at: new Date(),
        captured_by: capturedBy,
      };
      this.evalSnapshots.set(id as string, row);
      return [row as T];
    }

    if (sql.startsWith("SELECT id, workspace_id, source_conversation_id, source_message_id, fidelity, messages") && sql.includes("FROM eval_snapshots")) {
      const [workspaceId, id] = params as [string, string];
      const row = this.evalSnapshots.get(id);
      return row?.workspace_id === workspaceId ? [row as T] : [];
    }

    if (sql.startsWith("INSERT INTO eval_runs")) {
      const [
        id,
        workspaceId,
        snapshotId,
        caseId,
        mode,
        overrides,
        resolvedConfig,
        observedOutput,
        assertionVerdicts,
        status,
        outcomeReason,
        completedAt,
      ] = params as unknown[];
      const row = {
        id,
        workspace_id: workspaceId,
        snapshot_id: snapshotId,
        case_id: caseId,
        mode,
        overrides: typeof overrides === "string" ? JSON.parse(overrides) : overrides,
        resolved_config: typeof resolvedConfig === "string" ? JSON.parse(resolvedConfig) : resolvedConfig,
        observed_output: typeof observedOutput === "string" ? JSON.parse(observedOutput) : observedOutput,
        assertion_verdicts: typeof assertionVerdicts === "string" ? JSON.parse(assertionVerdicts) : assertionVerdicts,
        status,
        outcome_reason: outcomeReason,
        started_at: new Date(),
        completed_at: completedAt,
      };
      this.evalRuns.set(id as string, row);
      return [row as T];
    }

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

    if (sql.startsWith("SELECT backfill_completed_at::text AS backfill_completed_at")) {
      const connectorFirst = sql.includes("WHERE connector_id = $1 AND workspace_id = $2");
      const [workspaceId, connectorId] = connectorFirst
        ? [params[1] as string, params[0] as string]
        : [params[0] as string, params[1] as string];
      const state = this.syncStates.get(this.key(workspaceId, connectorId));
      return state
        ? [
            {
              backfill_completed_at: state.backfillCompletedAt?.toISOString() ?? null,
              sync_requested_at: state.syncRequestedAt?.toISOString() ?? null,
              sync_started_at: state.syncStartedAt?.toISOString() ?? null,
              last_run_at: state.lastRunAt?.toISOString() ?? null,
              last_modified_at: state.lastModifiedAt?.toISOString() ?? null,
              last_ingested_count: state.lastIngestedCount,
              last_error: state.lastError,
            } as T,
          ]
        : [];
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
      const [workspaceId, connectorId, rawConfig, errorStatus] = params as [string, string, string, string | null];
      const key = this.key(workspaceId, connectorId);
      const existing = this.configs.get(key);
      const insertsEnabledColumn = /^INSERT INTO connector_configs \([^)]*\benabled\b/.test(sql);
      const configData =
        typeof rawConfig === "string" ? (JSON.parse(rawConfig) as Record<string, string>) : (rawConfig as Record<string, string>);
      this.configs.set(key, {
        id: existing?.id ?? randomUUID(),
        workspaceId,
        connectorId,
        enabled: insertsEnabledColumn ? true : existing?.enabled ?? false,
        configData,
        errorStatus: errorStatus ?? null,
        createdAt: existing?.createdAt ?? new Date(),
        updatedAt: new Date(),
      });
      return [];
    }

    if (sql.startsWith("INSERT INTO connector_sync_state")) {
      const connectorFirst = sql.includes("(connector_id, workspace_id");
      const [workspaceId, connectorId] = connectorFirst
        ? [params[1] as string, params[0] as string]
        : [params[0] as string, params[1] as string];
      const existing = this.syncStates.get(this.key(workspaceId, connectorId));
      const setsLastIngestedCount = sql.includes("last_ingested_count");
      const ingestedCount = setsLastIngestedCount
        ? (params[3] as number | null)
        : existing?.lastIngestedCount ?? null;
      if (sql.includes("RETURNING workspace_id")) {
        if (existing?.syncRequestedAt || existing?.syncStartedAt) {
          return [];
        }
        this.syncStates.set(this.key(workspaceId, connectorId), {
          workspaceId,
          connectorId,
          backfillCompletedAt: existing?.backfillCompletedAt ?? null,
          syncRequestedAt: new Date(),
          syncStartedAt: existing?.syncStartedAt ?? null,
          syncLockToken: existing?.syncLockToken ?? null,
          lastRunAt: existing?.lastRunAt ?? null,
          lastModifiedAt: existing?.lastModifiedAt ?? null,
          lastIngestedCount: existing?.lastIngestedCount ?? null,
          lastError: existing?.lastError ?? null,
        });
        return [{ workspace_id: workspaceId } as T];
      }
      if (sql.includes("RETURNING sync_lock_token")) {
        if (existing?.syncStartedAt && !existing.syncRequestedAt) {
          return [];
        }
        const lockToken = params[2] as string;
        this.syncStates.set(this.key(workspaceId, connectorId), {
          workspaceId,
          connectorId,
          backfillCompletedAt: existing?.backfillCompletedAt ?? null,
          syncRequestedAt: null,
          syncStartedAt: new Date(),
          syncLockToken: lockToken,
          lastRunAt: new Date(),
          lastModifiedAt: existing?.lastModifiedAt ?? null,
          lastIngestedCount: existing?.lastIngestedCount ?? null,
          lastError: existing?.lastError ?? null,
        });
        return [{ sync_lock_token: lockToken } as T];
      }
      const lockToken = params[4] as string | undefined;
      if (sql.includes("WHERE connector_sync_state.sync_lock_token = $5") && existing?.syncLockToken !== lockToken) {
        return [];
      }
      this.syncStates.set(this.key(workspaceId, connectorId), {
        workspaceId,
        connectorId,
        backfillCompletedAt: sql.includes("backfill_completed_at")
          ? new Date()
          : existing?.backfillCompletedAt ?? null,
        syncRequestedAt: sql.includes("sync_requested_at") && !sql.includes("sync_requested_at = NULL")
          ? new Date()
          : sql.includes("sync_requested_at = NULL")
            ? null
            : existing?.syncRequestedAt ?? null,
        syncStartedAt: sql.includes("sync_started_at") && !sql.includes("sync_started_at = NULL")
          ? new Date()
          : sql.includes("sync_started_at = NULL")
            ? null
            : existing?.syncStartedAt ?? null,
        syncLockToken: sql.includes("sync_lock_token") && !sql.includes("sync_lock_token = NULL")
          ? lockToken ?? existing?.syncLockToken ?? null
          : null,
        lastRunAt: sql.includes("last_run_at")
          ? new Date()
          : existing?.lastRunAt ?? null,
        lastModifiedAt: sql.includes("last_modified_at")
          ? new Date()
          : existing?.lastModifiedAt ?? null,
        lastIngestedCount: ingestedCount,
        lastError: existing?.lastError ?? null,
      });
      return [];
    }

    if (/^UPDATE connector_sync_state\s+SET sync_started_at = NULL/.test(sql)) {
      const [connectorId, workspaceId, lockToken] = params as [string, string, string];
      const state = this.syncStates.get(this.key(workspaceId, connectorId));
      if (state && state.syncLockToken === lockToken) {
        state.syncStartedAt = null;
        state.syncLockToken = null;
      }
      return [];
    }

    if (/^UPDATE connector_sync_state\s+SET sync_started_at = NOW\(\)/.test(sql)) {
      const [connectorId, workspaceId, lockToken] = params as [string, string, string];
      const state = this.syncStates.get(this.key(workspaceId, connectorId));
      if (state && state.syncLockToken === lockToken) {
        state.syncStartedAt = new Date();
      }
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

    if (/^UPDATE connector_configs\s+SET error_status = NULL/.test(sql)) {
      const [workspaceId, connectorId, errorStatus] = params as [string, string, string];
      const config = this.configs.get(this.key(workspaceId, connectorId));
      if (config?.errorStatus === errorStatus) {
        config.errorStatus = null;
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

export class InMemoryDocumentSourceRepository implements DocumentSourceRepositoryPort {
  readonly items = new Map<string, DocumentSourceRecord>();
  private documentRepository?: InMemoryDocumentRepository;

  setDocumentRepository(documentRepository: InMemoryDocumentRepository): void {
    this.documentRepository = documentRepository;
  }

  async findByIdAndWorkspaceId(sourceId: string, workspaceId: string): Promise<DocumentSourceRecord | null> {
    const source = this.items.get(sourceId);
    return source && source.workspaceId === workspaceId ? source : null;
  }

  async findExistingIdsByWorkspaceId(workspaceId: string, sourceIds: string[]): Promise<string[]> {
    const allowedIds = new Set(sourceIds);
    return [...this.items.values()]
      .filter((source) => source.workspaceId === workspaceId && allowedIds.has(source.id))
      .map((source) => source.id);
  }

  async listByWorkspaceIdWithDocumentCounts(workspaceId: string): Promise<Array<DocumentSourceRecord & { documentCount: number }>> {
    return [...this.items.values()]
      .filter((source) => source.workspaceId === workspaceId)
      .map((source) => ({
        ...source,
        documentCount: this.documentRepository
          ? [...this.documentRepository.items.values()].filter((document) =>
              document.workspaceId === workspaceId && document.sourceId === source.id,
            ).length
          : 0,
      }))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id));
  }

  async countDocumentsWithoutSource(workspaceId: string): Promise<number> {
    if (!this.documentRepository) {
      return 0;
    }

    return [...this.documentRepository.items.values()]
      .filter((document) => document.workspaceId === workspaceId && document.sourceId === null)
      .length;
  }

  async upsertByExternalId(input: {
    workspaceId: string;
    kind: DocumentOriginKind;
    name: string;
    externalId: string;
    config?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): Promise<DocumentSourceRecord> {
    const existing = [...this.items.values()].find(
      (item) =>
        item.workspaceId === input.workspaceId &&
        item.kind === input.kind &&
        item.externalId === input.externalId,
    );
    if (existing) {
      const updated: DocumentSourceRecord = {
        ...existing,
        name: input.name,
        config: input.config ?? {},
        metadata: {
          ...existing.metadata,
          ...(input.metadata ?? {}),
        },
        updatedAt: new Date(),
      };
      this.items.set(updated.id, updated);
      return updated;
    }

    const source: DocumentSourceRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      kind: input.kind,
      name: input.name,
      externalId: input.externalId,
      config: input.config ?? {},
      metadata: input.metadata ?? {},
      lastSyncStatus: null,
      lastSyncedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.items.set(source.id, source);
    return source;
  }

  async updateSyncState(input: {
    workspaceId: string;
    sourceId: string;
    status: string;
    syncedAt?: Date | null;
  }): Promise<void> {
    const source = await this.findByIdAndWorkspaceId(input.sourceId, input.workspaceId);
    if (!source) {
      return;
    }
    this.items.set(source.id, {
      ...source,
      lastSyncStatus: input.status,
      lastSyncedAt: input.syncedAt ?? source.lastSyncedAt,
      updatedAt: new Date(),
    });
  }

  async updateConfigByIdAndWorkspaceId(input: {
    sourceId: string;
    workspaceId: string;
    config: Record<string, unknown>;
  }): Promise<DocumentSourceRecord> {
    const source = await this.findByIdAndWorkspaceId(input.sourceId, input.workspaceId);
    if (!source) {
      throw new Error(`Document source ${input.sourceId} not found in workspace ${input.workspaceId}`);
    }
    const updated: DocumentSourceRecord = {
      ...source,
      config: input.config,
      updatedAt: new Date(),
    };
    this.items.set(updated.id, updated);
    return updated;
  }

  async deleteByIdAndWorkspaceId(sourceId: string, workspaceId: string): Promise<boolean> {
    const source = await this.findByIdAndWorkspaceId(sourceId, workspaceId);
    if (!source) {
      return false;
    }
    this.items.delete(sourceId);
    return true;
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
      failedDocumentCount: documents.filter((item) => item.status === "failed").length,
      sampleDocumentCount: sampleDocuments.length,
      sampleDocumentSlugs: sampleDocuments
        .map((item) => item.metadata.sampleSlug)
        .filter((value): value is string => typeof value === "string"),
    };
  }

  async createAndQueue(input: DocumentCreateInput, options?: DocumentProcessingJobOptions | null): Promise<DocumentRecord> {
    const record: DocumentRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      title: input.title,
      sourceContent: input.sourceContent,
      markdownContent: input.markdownContent,
      metadata: input.metadata ?? {},
      sourceId: input.sourceId ?? null,
      source: input.source ?? null,
      externalDocumentId: input.externalDocumentId ?? null,
      sourceKind: input.sourceKind ?? "inline_text",
      sourceFilename: input.sourceFilename ?? null,
      sourceMimeType: input.sourceMimeType ?? null,
      sourceStorageBucket: input.sourceStorageBucket ?? null,
      sourceStorageObject: input.sourceStorageObject ?? null,
      sourceStorageGeneration: input.sourceStorageGeneration ?? null,
      sourceSizeBytes: input.sourceSizeBytes ?? null,
      contentSizeBytes: input.contentSizeBytes ?? null,
      contentHash: input.contentHash ?? null,
      retrievalEnabled: true,
      retrievalExpiresAt: null,
      status: "queued",
      revision: 1,
      failureReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    if (record.externalDocumentId) {
      const existing = [...this.items.values()].find(
        (item) =>
          item.workspaceId === record.workspaceId &&
          item.externalDocumentId === record.externalDocumentId &&
          (record.sourceId
            ? item.sourceId === record.sourceId
            : !item.sourceId),
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
          enrichment: null,
          sourceId: record.sourceId,
          source: record.source,
          status: "queued",
          revision: existing.revision + 1,
          failureReason: null,
          updatedAt: new Date(),
        };

        await this.jobRepository?.enqueue({
          documentId: updated.id,
          workspaceId: updated.workspaceId,
          documentRevision: updated.revision,
          options,
        });
        this.items.set(updated.id, updated);
        return updated;
      }
    }

    await this.jobRepository?.enqueue({
      documentId: record.id,
      workspaceId: record.workspaceId,
      documentRevision: record.revision,
      options,
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
      sourceId: input.sourceId ?? null,
      source: input.source ?? null,
      externalDocumentId: input.externalDocumentId ?? null,
      sourceKind: input.sourceKind ?? "inline_text",
      sourceFilename: input.sourceFilename ?? null,
      sourceMimeType: input.sourceMimeType ?? null,
      sourceStorageBucket: input.sourceStorageBucket ?? null,
      sourceStorageObject: input.sourceStorageObject ?? null,
      sourceStorageGeneration: input.sourceStorageGeneration ?? null,
      sourceSizeBytes: input.sourceSizeBytes ?? null,
      contentSizeBytes: input.contentSizeBytes ?? null,
      contentHash: input.contentHash ?? null,
      retrievalEnabled: true,
      retrievalExpiresAt: null,
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
        retrievalEnabled: item.retrievalEnabled,
        retrievalExpiresAt: item.retrievalExpiresAt,
        metadata: item.metadata,
        enrichment: item.enrichment ?? null,
        sourceId: item.sourceId ?? null,
        source: item.source ?? null,
        externalDocumentId: item.externalDocumentId ?? null,
        sourceKind: item.sourceKind,
        sourceFilename: item.sourceFilename,
        sourceMimeType: item.sourceMimeType,
        sourceStorageBucket: item.sourceStorageBucket,
        sourceStorageObject: item.sourceStorageObject,
        sourceStorageGeneration: item.sourceStorageGeneration,
        sourceSizeBytes: item.sourceSizeBytes,
        contentSizeBytes: item.contentSizeBytes ?? null,
        contentSize: item.contentSizeBytes ?? item.sourceSizeBytes ?? null,
      }));
  }

  async listSummariesByStatus(
    workspaceId: string,
    statuses: ReadonlyArray<string>,
    input: { limit: number },
  ): Promise<DocumentSummaryRecord[]> {
    const matching = [...this.items.values()]
      .filter((item) => item.workspaceId === workspaceId && statuses.includes(item.status))
      .sort((a, b) => (b.updatedAt.getTime() - a.updatedAt.getTime()) || b.id.localeCompare(a.id))
      .slice(0, input.limit);
    const summaries = new Map(
      (await this.listSummariesByIdsAndWorkspaceId(workspaceId, matching.map((item) => item.id)))
        .map((summary) => [summary.id, summary]),
    );

    return matching.flatMap((item) => summaries.get(item.id) ?? []);
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

  async findByExternalDocumentId(
    workspaceId: string,
    externalDocumentId: string,
  ): Promise<DocumentRecord | null> {
    for (const item of this.items.values()) {
      if (item.workspaceId === workspaceId && item.externalDocumentId === externalDocumentId) {
        return item;
      }
    }
    return null;
  }

  async findBySourceAndExternalDocumentId(
    workspaceId: string,
    sourceId: string,
    externalDocumentId: string,
  ): Promise<DocumentRecord | null> {
    for (const item of this.items.values()) {
      if (
        item.workspaceId === workspaceId &&
        item.sourceId === sourceId &&
        item.externalDocumentId === externalDocumentId
      ) {
        return item;
      }
    }
    return null;
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
      sourceId: input.sourceId ?? existing.sourceId ?? null,
      source: input.source ?? existing.source ?? null,
      externalDocumentId: input.externalDocumentId ?? existing.externalDocumentId ?? null,
      sourceKind: input.sourceKind ?? existing.sourceKind,
      sourceFilename: input.sourceFilename ?? existing.sourceFilename ?? null,
      sourceMimeType: input.sourceMimeType ?? existing.sourceMimeType ?? null,
      sourceStorageBucket: input.sourceStorageBucket ?? existing.sourceStorageBucket ?? null,
      sourceStorageObject: input.sourceStorageObject ?? existing.sourceStorageObject ?? null,
      sourceStorageGeneration: input.sourceStorageGeneration ?? existing.sourceStorageGeneration ?? null,
      sourceSizeBytes: input.sourceSizeBytes ?? existing.sourceSizeBytes ?? null,
      contentSizeBytes: input.contentSizeBytes ?? existing.contentSizeBytes ?? null,
      contentHash: input.contentHash ?? existing.contentHash ?? null,
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
          item.externalDocumentId === input.externalDocumentId &&
          (input.sourceId ? item.sourceId === input.sourceId : !item.sourceId),
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
      ...(input.enrichment ? { enrichment: input.enrichment as unknown as DocumentRecord["enrichment"] } : {}),
      sourceId: input.sourceId ?? existing.sourceId ?? null,
      source: input.source ?? existing.source ?? null,
      externalDocumentId: input.externalDocumentId ?? existing.externalDocumentId ?? null,
      sourceKind: input.sourceKind ?? existing.sourceKind,
      sourceFilename: input.sourceFilename ?? existing.sourceFilename ?? null,
      sourceMimeType: input.sourceMimeType ?? existing.sourceMimeType ?? null,
      sourceStorageBucket: input.sourceStorageBucket ?? existing.sourceStorageBucket ?? null,
      sourceStorageObject: input.sourceStorageObject ?? existing.sourceStorageObject ?? null,
      sourceStorageGeneration: input.sourceStorageGeneration ?? existing.sourceStorageGeneration ?? null,
      sourceSizeBytes: input.sourceSizeBytes ?? existing.sourceSizeBytes ?? null,
      contentSizeBytes: input.contentSizeBytes ?? existing.contentSizeBytes ?? null,
      contentHash: input.contentHash ?? existing.contentHash ?? null,
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

  async updateMetadataAndQueue(input: {
    documentId: string;
    workspaceId: string;
    metadata: Record<string, unknown>;
    enrichment?: Record<string, unknown>;
  }): Promise<DocumentRecord> {
    const existing = this.items.get(input.documentId);
    if (!existing || existing.workspaceId !== input.workspaceId) {
      throw notFound("Document not found");
    }

    const record: DocumentRecord = {
      ...existing,
      metadata: input.metadata,
      ...(input.enrichment ? { enrichment: input.enrichment as unknown as DocumentRecord["enrichment"] } : {}),
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

  async requeueAndQueue(
    documentId: string,
    workspaceId: string,
    options?: DocumentProcessingJobOptions | null,
  ): Promise<DocumentRecord> {
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
      options,
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

  async updateMetadataForRevision(input: {
    documentId: string;
    workspaceId: string;
    revision: number;
    metadata: Record<string, unknown>;
    enrichment?: Record<string, unknown> | null;
  }): Promise<DocumentRecord | null> {
    const existing = this.items.get(input.documentId);
    if (!existing || existing.workspaceId !== input.workspaceId || existing.revision !== input.revision) {
      return null;
    }

    const record: DocumentRecord = {
      ...existing,
      metadata: input.metadata,
      ...(input.enrichment !== undefined
        ? { enrichment: input.enrichment as unknown as DocumentRecord["enrichment"] }
        : {}),
      updatedAt: new Date(),
    };
    this.items.set(record.id, record);
    return record;
  }

  async setRetrievalEligibility(input: {
    documentId: string;
    workspaceId: string;
    retrievalEnabled: boolean;
    retrievalExpiresAt: Date | null;
  }): Promise<DocumentRecord | null> {
    const existing = this.items.get(input.documentId);
    if (!existing || existing.workspaceId !== input.workspaceId) {
      return null;
    }

    const record: DocumentRecord = {
      ...existing,
      retrievalEnabled: input.retrievalEnabled,
      retrievalExpiresAt: input.retrievalExpiresAt,
      updatedAt: new Date(),
    };
    this.items.set(record.id, record);
    return record;
  }

  async requeueAllEligibleAndQueue(workspaceId: string, options?: DocumentProcessingJobOptions | null): Promise<{
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
        options,
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

  async requeueSourceEligibleAndQueue(input: {
    workspaceId: string;
    sourceId: string | null;
    options?: DocumentProcessingJobOptions | null;
  }): Promise<{
    queuedDocumentCount: number;
    skippedDocumentCount: number;
    queuedDocuments: Array<{ documentId: string; revision: number }>;
  }> {
    const documents = [...this.items.values()].filter(
      (item) => item.workspaceId === input.workspaceId && item.sourceId === input.sourceId,
    );
    let queuedDocumentCount = 0;
    let skippedDocumentCount = 0;
    const queuedDocuments: Array<{ documentId: string; revision: number }> = [];

    for (const document of documents) {
      if (document.status !== "ready" && document.status !== "failed") {
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
        options: input.options,
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

  async listSummaryPageBySourceId(
    workspaceId: string,
    sourceId: string | null,
    input: { limit: number; offset?: number; cursor?: string },
  ): Promise<{ documents: DocumentSummaryRecord[]; total: number; nextCursor: string | null; hasMore: boolean }> {
    const filtered = [...this.items.values()]
      .filter((item) => item.workspaceId === workspaceId && (sourceId === null ? !item.sourceId : item.sourceId === sourceId))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
    const offset = input.offset ?? 0;
    const sliced = filtered.slice(offset, offset + input.limit + 1);
    const documents: DocumentSummaryRecord[] = sliced.slice(0, input.limit);
    return { documents, total: filtered.length, nextCursor: null, hasMore: sliced.length > input.limit };
  }

  async deleteBySourceIdAndWorkspaceId(sourceId: string, workspaceId: string): Promise<{
    count: number;
    storageRefs: Array<{ bucket: string; objectPath: string; generation: string | null }>;
  }> {
    let count = 0;
    const storageRefs: Array<{ bucket: string; objectPath: string; generation: string | null }> = [];
    for (const [id, doc] of this.items.entries()) {
      if (doc.sourceId === sourceId && doc.workspaceId === workspaceId) {
        if (doc.sourceKind === "uploaded_file" && doc.sourceStorageBucket && doc.sourceStorageObject) {
          storageRefs.push({
            bucket: doc.sourceStorageBucket,
            objectPath: doc.sourceStorageObject,
            generation: doc.sourceStorageGeneration ?? null,
          });
        }
        this.items.delete(id);
        count += 1;
      }
    }
    return { count, storageRefs };
  }

  async findActivePageState(input: {
    workspaceId: string;
    sourceId?: string | null;
    externalDocumentId: string;
  }): Promise<{
    documentId: string;
    revision: number;
    contentSizeBytes: number | null;
    contentHash: string | null;
  } | null> {
    const sourceId = input.sourceId ?? null;
    const match = [...this.items.values()].find((doc) =>
      doc.workspaceId === input.workspaceId &&
      doc.externalDocumentId === input.externalDocumentId &&
      doc.status !== "failed" &&
      (sourceId === null ? !doc.sourceId : doc.sourceId === sourceId),
    );
    if (!match) {
      return null;
    }
    return {
      documentId: match.id,
      revision: match.revision,
      contentSizeBytes: match.contentSizeBytes ?? null,
      contentHash: match.contentHash ?? null,
    };
  }

  async deleteMissingPagesBySourceAndExternalIds(input: {
    workspaceId: string;
    sourceId: string;
    keepExternalDocumentIds: string[];
  }): Promise<{ deletedCount: number; deletedContentBytes: number }> {
    const keep = new Set(input.keepExternalDocumentIds.filter((value) => Boolean(value)));
    let deletedCount = 0;
    let deletedContentBytes = 0;
    for (const [id, doc] of this.items.entries()) {
      if (
        doc.workspaceId === input.workspaceId &&
        doc.sourceId === input.sourceId &&
        doc.externalDocumentId &&
        !keep.has(doc.externalDocumentId)
      ) {
        deletedContentBytes += doc.contentSizeBytes ?? 0;
        this.items.delete(id);
        deletedCount += 1;
      }
    }
    return { deletedCount, deletedContentBytes };
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
    const objectPath = `workspaces/${input.workspaceId}/documents/${input.documentId}`;
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
  readonly publications: Array<
    Parameters<ChunkRepositoryPort["publishForDocumentRevision"]>[0]
  > = [];

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
    embeddingSpace: Parameters<
      ChunkRepositoryPort["publishForDocumentRevision"]
    >[0]["embeddingSpace"];
    canonicalVersion: string;
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

    this.publications.push(input);
    this.items.set(input.documentId, input.chunks);
    return true;
  }

  async listForDocumentRevision(input: { documentId: string; workspaceId: string }) {
    const chunks = this.items.get(input.documentId) ?? [];
    return chunks
      .filter((chunk) => chunk.workspaceId === input.workspaceId)
      .slice()
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
      .map((chunk) => ({
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
        metadata: chunk.metadata ?? {},
      }));
  }

  async updateMetadataForDocumentRevision(input: {
    documentId: string;
    workspaceId: string;
    revision: number;
    patches: Array<{ chunkIndex: number; metadata: Record<string, unknown> }>;
  }): Promise<boolean> {
    const document = this.documentRepository?.items.get(input.documentId);
    if (!document || document.workspaceId !== input.workspaceId || document.revision !== input.revision) {
      return false;
    }

    const chunks = this.items.get(input.documentId) ?? [];
    const patchByIndex = new Map(input.patches.map((patch) => [patch.chunkIndex, patch.metadata]));
    this.items.set(
      input.documentId,
      chunks.map((chunk) =>
        patchByIndex.has(chunk.chunkIndex)
          ? { ...chunk, metadata: patchByIndex.get(chunk.chunkIndex)! }
          : chunk,
      ),
    );
    return true;
  }

  async listSummariesForDocument(input: { documentId: string; workspaceId: string }) {
    const chunks = this.items.get(input.documentId) ?? [];
    return chunks
      .filter((chunk) => chunk.workspaceId === input.workspaceId)
      .slice()
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
      .map((chunk) => ({
        id: chunk.id,
        chunkIndex: chunk.chunkIndex,
        contentPreview: chunk.content.slice(0, 240),
        contentLength: chunk.content.length,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
        dateFrom: typeof chunk.metadata?.dateFrom === "string" ? chunk.metadata.dateFrom : null,
        dateTo: typeof chunk.metadata?.dateTo === "string" ? chunk.metadata.dateTo : null,
      }));
  }

  async findByIdForDocument(input: { chunkId: string; documentId: string; workspaceId: string }) {
    const chunks = this.items.get(input.documentId) ?? [];
    const chunk = chunks.find(
      (entry) => entry.id === input.chunkId && entry.workspaceId === input.workspaceId,
    );
    if (!chunk) {
      return null;
    }
    return {
      id: chunk.id,
      documentId: chunk.documentId,
      workspaceId: chunk.workspaceId,
      chunkIndex: chunk.chunkIndex,
      content: chunk.content,
      searchText: chunk.searchText ?? null,
      startOffset: chunk.startOffset,
      endOffset: chunk.endOffset,
      metadata: chunk.metadata ?? {},
      createdAt: chunk.createdAt,
      embeddingDimensions: chunk.embedding.length,
    };
  }
}

const jobPriority = (kind: DocumentProcessingJobRecord["kind"]): number =>
  kind === "vectorize" ? 0 : kind === "embedding_profile" ? 1 : 2;

export class InMemoryDocumentProcessingJobRepository implements DocumentProcessingJobRepositoryPort {
  readonly items = new Map<string, DocumentProcessingJobRecord>();

  constructor(private documentRepository?: InMemoryDocumentRepository) {}

  setDocumentRepository(documentRepository: InMemoryDocumentRepository): void {
    this.documentRepository = documentRepository;
  }

  async enqueue(input: { documentId: string; workspaceId: string; documentRevision: number; kind?: DocumentProcessingJobRecord["kind"]; options?: DocumentProcessingJobRecord["options"] | null }): Promise<DocumentProcessingJobRecord> {
    const record: DocumentProcessingJobRecord = {
      id: randomUUID(),
      documentId: input.documentId,
      workspaceId: input.workspaceId,
      documentRevision: input.documentRevision,
      kind: input.kind ?? "vectorize",
      status: "queued",
      attemptCount: 0,
      lastError: null,
      availableAt: new Date(),
      claimedAt: null,
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      options: input.options ?? null,
    };
    this.items.set(record.id, record);
    return record;
  }

  async ensureEnrichJob(input: { documentId: string; workspaceId: string; documentRevision: number; options?: DocumentProcessingJobRecord["options"] | null }): Promise<DocumentProcessingJobRecord> {
    const existing = [...this.items.values()].find(
      (item) =>
        item.documentId === input.documentId &&
        item.documentRevision === input.documentRevision &&
        item.kind === "enrich",
    );
    if (existing) {
      return existing;
    }
    return this.enqueue({ ...input, kind: "enrich" });
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
        && item.documentRevision === input.documentRevision
        && item.kind === "vectorize")
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null;
  }

  async claimNext(now: Date = new Date()): Promise<DocumentProcessingJobRecord | null> {
    const next = [...this.items.values()]
      .filter((item) => item.status === "queued" && item.availableAt <= now)
      .sort((left, right) =>
        jobPriority(left.kind) - jobPriority(right.kind) ||
        left.createdAt.getTime() - right.createdAt.getTime())[0];

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
          (job) =>
            job.documentId === document.id &&
            job.documentRevision === document.revision &&
            job.kind === "vectorize",
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

  async ensureEmbeddingProfileJobsForTransition(): Promise<number> {
    return 0;
  }

  async cancelEmbeddingProfileJobsForTransition(): Promise<number> {
    return 0;
  }

  async reconcileEmbeddingProfileJobsForWorkspace(): Promise<{ enqueued: number; skipped: number }> {
    return { enqueued: 0, skipped: 0 };
  }

  // Reports the canonical projection backlog, which this in-memory fake does not
  // model; the operator backfill that consumes it is covered by an integration test
  // against Postgres.
  async listWorkspaceCanonicalEmbeddingGaps(): Promise<
    Array<{
      workspaceId: string;
      missingChunks: number;
      hasEmbeddingProfile: boolean;
      failedJobs: number;
    }>
  > {
    return [];
  }

  // Coverage is a count over chunks and canonical rows, neither of which this fake
  // holds; the real query is covered by an integration test against Postgres. Tests
  // that need a non-empty reading set one here.
  readonly canonicalEmbeddingCoverage = new Map<
    string,
    Omit<WorkspaceCanonicalEmbeddingCoverage, "workspaceId">
  >();

  async getWorkspaceCanonicalEmbeddingCoverage(
    workspaceId: string,
  ): Promise<WorkspaceCanonicalEmbeddingCoverage> {
    const stored = this.canonicalEmbeddingCoverage.get(workspaceId);
    return {
      workspaceId,
      eligibleChunks: stored?.eligibleChunks ?? 0,
      coveredChunks: stored?.coveredChunks ?? 0,
      missingChunks: stored?.missingChunks ?? 0,
      hasEmbeddingProfile: stored?.hasEmbeddingProfile ?? false,
      queuedJobs: stored?.queuedJobs ?? 0,
      failedJobs: stored?.failedJobs ?? 0,
    };
  }

  async listQueuedEmbeddingProfileJobsForWorkspace(input: {
    workspaceId: string;
    embeddingSpaceId?: string;
    generation?: string;
    limit?: number;
  }): Promise<DocumentProcessingJobRecord[]> {
    return [...this.items.values()]
      .filter((item) =>
        item.workspaceId === input.workspaceId
        && item.kind === "embedding_profile"
        && item.status === "queued"
        && (!input.embeddingSpaceId || item.embeddingSpaceId === input.embeddingSpaceId)
        && (!input.generation || item.workspaceProfileGeneration === input.generation))
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .slice(0, input.limit);
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
  private ownershipReader: Pick<InMemoryConversationOwnershipRepository, "load"> | null = null;

  setMessageRepository(messageRepository: InMemoryMessageRepository): void {
    this.messageRepository = messageRepository;
  }

  setOwnershipReader(ownershipReader: Pick<InMemoryConversationOwnershipRepository, "load">): void {
    this.ownershipReader = ownershipReader;
  }

  async getOrCreateByAnonymousSession(input: {
    workspaceId: string;
    agentId: string;
    sourceChannel: string;
    anonymousSessionId: string;
    sourceOrigin?: string | null;
  }): Promise<GetOrCreateConversationResult> {
    const existing = [...this.items.values()]
      .filter((item) =>
        item.workspaceId === input.workspaceId &&
        item.agentId === input.agentId &&
        item.sourceChannel === input.sourceChannel &&
        item.anonymousSessionId === input.anonymousSessionId
      )
      .sort((left, right) => {
        const updatedDiff = right.updatedAt.getTime() - left.updatedAt.getTime();
        if (updatedDiff !== 0) return updatedDiff;
        const createdDiff = right.createdAt.getTime() - left.createdAt.getTime();
        return createdDiff !== 0 ? createdDiff : right.id.localeCompare(left.id);
      })[0];
    if (existing) {
      return { record: existing, created: false };
    }
    return { record: await this.create(
      input.workspaceId,
      input.agentId,
      input.sourceChannel,
      input.anonymousSessionId,
      input.sourceOrigin ?? null,
    ), created: true };
  }

  async create(
    workspaceId: string,
    agentId: string | null = null,
    sourceChannel: string | null = null,
    anonymousSessionId: string | null = null,
    sourceOrigin: string | null = null,
    channelContext: ConversationRecord["channelContext"] = null,
    verifiedCustomerId: string | null = null,
    options?: { entryPageUrl?: string | null },
  ): Promise<ConversationRecord> {
    const record: ConversationRecord = {
      id: randomUUID(),
      workspaceId,
      agentId,
      agentName: null,
      agentInternalName: null,
      sourceChannel,
      sourceOrigin,
      channelContext,
      anonymousSessionId,
      verifiedCustomerId,
      entryPageUrl: options?.entryPageUrl ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.items.set(record.id, record);
    return record;
  }

  async createWithInitialAssistantMessage(input: {
    workspaceId: string;
    agentId?: string | null;
    sourceChannel?: string | null;
    anonymousSessionId?: string | null;
    sourceOrigin?: string | null;
    channelContext?: ConversationRecord["channelContext"];
    verifiedCustomerId?: string | null;
    entryPageUrl?: string | null;
    content: string;
  }): Promise<{ conversation: ConversationRecord; assistantMessage: MessageRecord }> {
    const conversation = await this.create(
      input.workspaceId,
      input.agentId ?? null,
      input.sourceChannel ?? null,
      input.anonymousSessionId ?? null,
      input.sourceOrigin ?? null,
      input.channelContext ?? null,
      input.verifiedCustomerId ?? null,
      { entryPageUrl: input.entryPageUrl ?? null },
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
    input: {
      limit: number;
      offset?: number;
      cursor?: string;
      sourceScope?: ConversationSourceScope;
      ownership?: ConversationOwnershipScope;
      agentId?: string | null;
    } = { limit: 50, offset: 0 },
  ): Promise<{ conversations: ConversationRecord[]; total: number; nextCursor: string | null; hasMore: boolean }> {
    const workspaceConversations = [...this.items.values()]
      .filter((item) => item.workspaceId === workspaceId && (!input.agentId || item.agentId === input.agentId))
      .sort((left, right) => {
        const timeDiff = right.updatedAt.getTime() - left.updatedAt.getTime();
        return timeDiff !== 0 ? timeDiff : right.id.localeCompare(left.id);
      });
    const conversations = input.ownership === "human_owned" && this.ownershipReader
      ? (await Promise.all(workspaceConversations.map(async (conversation) => ({
          conversation,
          ownership: await this.ownershipReader!.load(conversation.id),
        })))).filter(({ ownership }) => ownership?.state === "human_owned").map(({ conversation }) => conversation)
      : workspaceConversations;

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
    input: { limit: number; offset?: number; cursor?: string; agentId?: string | null } = { limit: 50, offset: 0 },
  ): Promise<{ conversations: ConversationRecord[]; total: number; nextCursor: string | null; hasMore: boolean }> {
    const conversations = [...this.items.values()]
      .filter((item) =>
        item.workspaceId === workspaceId &&
        item.anonymousSessionId === anonymousSessionId &&
        (!input.agentId || item.agentId === input.agentId)
      )
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
    agentId?: string | null,
  ): Promise<ConversationRecord | null> {
    const item = this.items.get(conversationId);
    return item &&
      item.workspaceId === workspaceId &&
      item.anonymousSessionId === anonymousSessionId &&
      (!agentId || item.agentId === agentId)
      ? item
      : null;
  }

  async touch(conversationId: string, workspaceId: string): Promise<void> {
    const item = this.items.get(conversationId);
    if (item && item.workspaceId === workspaceId) {
      item.updatedAt = new Date();
    }
  }

  async setVerifiedCustomerId(conversationId: string, workspaceId: string, customerId: string): Promise<void> {
    const item = this.items.get(conversationId);
    if (item && item.workspaceId === workspaceId && !item.verifiedCustomerId) {
      this.items.set(conversationId, { ...item, verifiedCustomerId: customerId, updatedAt: new Date() });
    }
  }
}

export class InMemoryConversationOwnershipRepository implements Pick<
  ConversationOwnershipRepository,
  "load" | "loadByConversationIds" | "requestHandoff" | "takeOver" | "transfer" | "handBack"
> {
  readonly items = new Map<string, ConversationOwnershipRecord>();

  async load(conversationId: string): Promise<ConversationOwnershipRecord | null> {
    return this.items.get(conversationId) ?? null;
  }

  async loadByConversationIds(
    conversationIds: string[],
  ): Promise<Map<string, ConversationOwnershipRecord>> {
    const result = new Map<string, ConversationOwnershipRecord>();
    for (const conversationId of conversationIds) {
      const record = this.items.get(conversationId);
      if (record) {
        result.set(conversationId, record);
      }
    }
    return result;
  }

  async requestHandoff(input: ConversationOwnershipRequestHandoffInput): Promise<ConversationOwnershipRequestHandoffResult> {
    const existing = this.items.get(input.conversationId);
    if (existing?.state === "human_owned") {
      return { record: existing, changed: false };
    }

    const record = this.createRecord({
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      state: "human_owned",
      ownerAccountId: null,
      ownerDisplayName: null,
      reason: input.reason,
      version: existing ? existing.version + 1 : 1,
      takenOverAt: null,
      createdAt: existing?.createdAt,
    });
    this.items.set(input.conversationId, record);
    return { record, changed: true };
  }

  async takeOver(input: ConversationOwnershipTakeOverInput): Promise<ConversationOwnershipMutationResult> {
    const existing = this.items.get(input.conversationId);
    if (!existing) {
      const record = this.createRecord({
        conversationId: input.conversationId,
        workspaceId: input.workspaceId,
        state: "human_owned",
        ownerAccountId: input.accountId,
        ownerDisplayName: input.displayName,
        reason: "operator_takeover",
        version: 1,
        takenOverAt: new Date(),
      });
      this.items.set(input.conversationId, record);
      return { ok: true, changed: true, record };
    }

    if (input.expectedVersion !== undefined && existing.version !== input.expectedVersion) {
      return { ok: false, changed: false, record: existing };
    }

    if (existing.state !== "ai_owned" && existing.ownerAccountId !== null) {
      return { ok: false, changed: false, record: existing };
    }

    const record = this.createRecord({
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      state: "human_owned",
      ownerAccountId: input.accountId,
      ownerDisplayName: input.displayName,
      reason: "operator_takeover",
      version: existing.version + 1,
      takenOverAt: new Date(),
      createdAt: existing.createdAt,
    });
    this.items.set(input.conversationId, record);
    return { ok: true, changed: true, record };
  }

  async transfer(input: ConversationOwnershipTransferInput): Promise<ConversationOwnershipMutationResult> {
    const existing = this.items.get(input.conversationId);
    if (!existing || existing.state !== "human_owned" || existing.version !== input.expectedVersion) {
      return { ok: false, changed: false, record: existing ?? null };
    }
    if (existing.ownerAccountId === input.accountId && existing.ownerDisplayName === input.displayName) {
      return { ok: true, changed: false, record: existing };
    }

    const record = this.createRecord({
      ...existing,
      ownerAccountId: input.accountId,
      ownerDisplayName: input.displayName,
      version: existing.version + 1,
      createdAt: existing.createdAt,
    });
    this.items.set(input.conversationId, record);
    return { ok: true, changed: true, record };
  }

  async handBack(input: ConversationOwnershipHandBackInput): Promise<ConversationOwnershipMutationResult> {
    const existing = this.items.get(input.conversationId);
    if (!existing || existing.version !== input.expectedVersion) {
      return { ok: false, changed: false, record: existing ?? null };
    }
    if (existing.state === "ai_owned" && existing.ownerAccountId === null && existing.ownerDisplayName === null) {
      return { ok: true, changed: false, record: existing };
    }

    const record = this.createRecord({
      ...existing,
      state: "ai_owned",
      ownerAccountId: null,
      ownerDisplayName: null,
      version: existing.version + 1,
      createdAt: existing.createdAt,
    });
    this.items.set(input.conversationId, record);
    return { ok: true, changed: true, record };
  }

  private createRecord(input: {
    conversationId: string;
    workspaceId: string;
    state: ConversationOwnershipRecord["state"];
    ownerAccountId: string | null;
    ownerDisplayName: string | null;
    reason: ConversationOwnershipRecord["reason"];
    version: number;
    takenOverAt: Date | null;
    createdAt?: Date;
  }): ConversationOwnershipRecord {
    const now = new Date();
    return {
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      state: input.state,
      ownerAccountId: input.ownerAccountId,
      ownerDisplayName: input.ownerDisplayName,
      reason: input.reason,
      version: input.version,
      takenOverAt: input.takenOverAt,
      createdAt: input.createdAt ?? now,
      updatedAt: now,
    };
  }
}

export class InMemoryMessageRepository implements MessageRepositoryPort {
  readonly items = new Map<string, MessageRecord[]>();
  private nextCreatedAtMs = Date.now();

  cursorFor(message: MessageRecord): string {
    return encodeCursor({
      createdAt: message.createdAt.toISOString(),
      id: message.id,
    });
  }

  async findByIdAndWorkspaceId(workspaceId: string, messageId: string): Promise<MessageRecord | null> {
    for (const messages of this.items.values()) {
      const message = messages.find((candidate) => candidate.workspaceId === workspaceId && candidate.id === messageId);
      if (message) return message;
    }
    return null;
  }

  async listByConversationId(workspaceId: string, conversationId: string): Promise<MessageRecord[]> {
    return [...(this.items.get(conversationId) ?? [])].filter((message) => message.workspaceId === workspaceId);
  }

  async listRecentByConversationId(workspaceId: string, conversationId: string, limit: number): Promise<MessageRecord[]> {
    return [...(this.items.get(conversationId) ?? [])]
      .filter((message) => message.workspaceId === workspaceId)
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .slice(-limit);
  }

  async countByConversationId(workspaceId: string, conversationId: string): Promise<number> {
    return (this.items.get(conversationId) ?? []).filter((message) => message.workspaceId === workspaceId).length;
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

  async listSinceByConversationId(
    workspaceId: string,
    conversationId: string,
    input: { sinceCreatedAt?: Date; sinceId?: string; limit: number },
  ): Promise<{ messages: MessageRecord[]; latestCursor: string | null }> {
    const messages = [...(this.items.get(conversationId) ?? [])]
      .filter((message) => message.workspaceId === workspaceId)
      .sort((left, right) => {
        const timeDiff = left.createdAt.getTime() - right.createdAt.getTime();
        return timeDiff !== 0 ? timeDiff : left.id.localeCompare(right.id);
      });
    const latest = messages.at(-1);
    const latestCursor = latest
      ? encodeCursor({
          createdAt: latest.createdAt.toISOString(),
          id: latest.id,
        })
      : null;

    if (!input.sinceCreatedAt || !input.sinceId) {
      const newest = messages.slice(-input.limit);
      const lastReturned = newest.at(-1);
      return {
        messages: newest,
        latestCursor: lastReturned ? this.cursorFor(lastReturned) : latestCursor,
      };
    }

    const newer = messages
      .filter((message) =>
        message.createdAt.getTime() > input.sinceCreatedAt!.getTime() ||
        (message.createdAt.getTime() === input.sinceCreatedAt!.getTime() && message.id > input.sinceId!)
      )
      .slice(0, input.limit);

    return {
      messages: newer,
      latestCursor: newer.at(-1)
        ? encodeCursor({
            createdAt: newer.at(-1)!.createdAt.toISOString(),
            id: newer.at(-1)!.id,
          })
        : latestCursor,
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
    id?: string;
    conversationId: string;
    workspaceId: string;
    role: "user" | "assistant" | "system";
    content: string;
    source?: MessageSource;
    operatorAccountId?: string;
    operatorDisplayName?: string;
    inputMetadata?: MessageRecord["inputMetadata"];
    metadata?: Record<string, unknown>;
    skillName?: string;
    skillOutcome?: string;
    skillStatus?: string;
  }): Promise<MessageRecord> {
    const metadata = input.metadata ?? (input.inputMetadata ? { ...input.inputMetadata } : undefined);
    const metadataWithOperator = input.operatorAccountId || input.operatorDisplayName
      ? {
          ...(metadata ?? {}),
          humanAgent: {
            accountId: input.operatorAccountId,
            displayName: input.operatorDisplayName,
          },
        }
      : metadata;
    const record: MessageRecord = {
      id: input.id ?? randomUUID(),
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      role: input.role,
      source: input.source ?? deriveMessageSourceFromRole(input.role),
      content: input.content,
      metadata: metadataWithOperator,
      inputMetadata: input.inputMetadata,
      skillName: input.skillName,
      skillOutcome: input.skillOutcome,
      skillStatus: input.skillStatus,
      createdAt: new Date(this.nextCreatedAtMs++),
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

  async listUnansweredChatAnswerEventsByUserMessageIds(
    workspaceId: string,
    conversationId: string,
    userMessageIds: string[],
  ): Promise<AuditEventRecord[]> {
    const ids = new Set(userMessageIds);
    if (ids.size === 0) {
      return [];
    }
    return this.items.filter((event) => {
      return (
        event.workspaceId === workspaceId &&
        event.eventType === "chat.answer" &&
        (event.eventStatus === "failure" || event.eventStatus === "cancelled") &&
        event.metadata.conversationId === conversationId &&
        typeof event.metadata.userMessageId === "string" &&
        ids.has(event.metadata.userMessageId) &&
        (event.metadata.assistantMessageId === undefined || event.metadata.assistantMessageId === null)
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
    };

    return true;
  }

  async listChatTurnEventsByAssistantMessageIds(
    workspaceId: string,
    conversationId: string,
    assistantMessageIds: string[],
  ): Promise<AuditEventRecord[]> {
    return this.items.filter((event) => {
      return (
        event.workspaceId === workspaceId &&
        (event.eventType === "chat.answer" || event.eventType === "chat.suspended") &&
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
    input: { limit: number; offset?: number; sourceScope?: ConversationSourceScope; agentId?: string | null } = { limit: 50, offset: 0 },
  ): Promise<{ items: HistoryItemsSourceRecord[]; total: number; hasMore: boolean }> {
    const offset = input.offset ?? 0;
    const conversations: HistoryItemsSourceRecord[] = [...this.conversationRepository.items.values()]
      .filter((conversation) => conversation.workspaceId === workspaceId && (!input.agentId || conversation.agentId === input.agentId))
      .map((conversation) => ({
        kind: "chat" as const,
        id: conversation.id,
        sortAt: conversation.updatedAt,
        conversation,
      }));
    const searches: HistoryItemsSourceRecord[] = this.auditEventRepository.items
      .filter((event) => event.workspaceId === workspaceId && event.eventType === "document.search" && !input.agentId)
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

/**
 * In-memory document type catalog store. Mirrors the conditional-write contract
 * of the Postgres repository: a save built on a stale revision resolves null.
 */
export class InMemoryDocumentTypeCatalogRepository implements DocumentTypeCatalogRepositoryPort {
  readonly items = new Map<string, DocumentTypeCatalogRecord>();

  async findByWorkspaceId(workspaceId: string): Promise<DocumentTypeCatalogRecord | null> {
    return this.items.get(workspaceId) ?? null;
  }

  async save(input: {
    workspaceId: string;
    expectedRevision: string;
    types: readonly OperatorDocumentTypeDefinition[];
    retiredFields: readonly RetiredDocumentTypeFieldIdentity[];
    disabledBuiltInTypeKeys: readonly string[];
  }): Promise<DocumentTypeCatalogRecord | null> {
    const existing = this.items.get(input.workspaceId);
    const currentRevision = existing?.revision ?? DEFAULT_DOCUMENT_TYPE_CATALOG_REVISION;
    if (currentRevision !== input.expectedRevision) {
      return null;
    }

    const record: DocumentTypeCatalogRecord = {
      workspaceId: input.workspaceId,
      revision: String(BigInt(currentRevision) + 1n),
      types: input.types.map((type) => ({ ...type, fields: type.fields.map((field) => ({ ...field })) })),
      retiredFields: input.retiredFields.map((identity) => ({ ...identity })),
      disabledBuiltInTypeKeys: [...input.disabledBuiltInTypeKeys],
    };
    this.items.set(input.workspaceId, record);
    return record;
  }
}
