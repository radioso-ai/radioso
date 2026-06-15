import { randomUUID } from "node:crypto";

import type {
  CreateOauthConnectionInput,
  OauthConnectionRecord,
  OauthConnectionRepositoryPort,
  UpdateOauthConnectionInput,
} from "../../src/db/repositories/oauthConnectionRepository.js";
import type { OauthConnectionStatus } from "../../src/modules/integrationOauth/public.js";

const clone = (record: OauthConnectionRecord): OauthConnectionRecord => ({
  ...record,
  grantedScopes: [...record.grantedScopes],
  createdAt: new Date(record.createdAt),
  updatedAt: new Date(record.updatedAt),
  lastRefreshAt: record.lastRefreshAt ? new Date(record.lastRefreshAt) : null,
});

export class InMemoryOauthConnectionRepository implements OauthConnectionRepositoryPort {
  private readonly rows = new Map<string, OauthConnectionRecord>();

  async create(input: CreateOauthConnectionInput): Promise<OauthConnectionRecord> {
    const now = new Date();
    const record: OauthConnectionRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      provider: input.provider,
      providerAccountId: input.providerAccountId ?? null,
      displayName: input.displayName,
      status: input.status ?? "pending",
      grantedScopes: [...(input.grantedScopes ?? [])],
      credentialCiphertext: input.credentialCiphertext ?? null,
      encryptionKeyId: input.encryptionKeyId ?? null,
      oauthClientCiphertext: input.oauthClientCiphertext ?? null,
      oauthFlowCiphertext: null,
      lastRefreshAt: null,
      lastErrorCode: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(record.id, record);
    return clone(record);
  }

  async findById(workspaceId: string, id: string): Promise<OauthConnectionRecord | null> {
    const record = this.rows.get(id);
    return record && record.workspaceId === workspaceId ? clone(record) : null;
  }

  async listByWorkspace(workspaceId: string): Promise<OauthConnectionRecord[]> {
    return [...this.rows.values()].filter((row) => row.workspaceId === workspaceId).map(clone);
  }

  async updateStatus(
    workspaceId: string,
    id: string,
    status: OauthConnectionStatus,
  ): Promise<OauthConnectionRecord | null> {
    const record = this.rows.get(id);
    if (!record || record.workspaceId !== workspaceId) {
      return null;
    }
    record.status = status;
    record.updatedAt = new Date();
    return clone(record);
  }

  async update(
    workspaceId: string,
    id: string,
    input: UpdateOauthConnectionInput,
  ): Promise<OauthConnectionRecord | null> {
    const record = this.rows.get(id);
    if (!record || record.workspaceId !== workspaceId) {
      return null;
    }
    if (input.displayName !== undefined) record.displayName = input.displayName;
    if (input.providerAccountId !== undefined) record.providerAccountId = input.providerAccountId;
    if (input.grantedScopes !== undefined) record.grantedScopes = [...input.grantedScopes];
    if (input.status !== undefined) record.status = input.status;
    if (input.credentialCiphertext !== undefined) record.credentialCiphertext = input.credentialCiphertext;
    if (input.encryptionKeyId !== undefined) record.encryptionKeyId = input.encryptionKeyId;
    if (input.oauthClientCiphertext !== undefined) record.oauthClientCiphertext = input.oauthClientCiphertext;
    if (input.oauthFlowCiphertext !== undefined) record.oauthFlowCiphertext = input.oauthFlowCiphertext;
    if (input.lastErrorCode !== undefined) record.lastErrorCode = input.lastErrorCode;
    record.updatedAt = new Date();
    return clone(record);
  }

  async setOauthFlow(
    workspaceId: string,
    id: string,
    oauthFlowCiphertext: string,
  ): Promise<OauthConnectionRecord | null> {
    const record = this.rows.get(id);
    if (!record || record.workspaceId !== workspaceId) {
      return null;
    }
    record.oauthFlowCiphertext = oauthFlowCiphertext;
    record.status = "pending";
    record.lastErrorCode = null;
    record.updatedAt = new Date();
    return clone(record);
  }

  async setOauthTokens(
    workspaceId: string,
    id: string,
    credentialCiphertext: string,
    encryptionKeyId: string | null,
    grantedScopes?: string[],
    providerAccountId?: string | null,
  ): Promise<OauthConnectionRecord | null> {
    const record = this.rows.get(id);
    if (!record || record.workspaceId !== workspaceId) {
      return null;
    }
    record.credentialCiphertext = credentialCiphertext;
    record.encryptionKeyId = encryptionKeyId;
    record.oauthFlowCiphertext = null;
    record.status = "authorized";
    record.lastRefreshAt = new Date();
    record.lastErrorCode = null;
    if (grantedScopes) record.grantedScopes = [...grantedScopes];
    if (providerAccountId !== undefined) record.providerAccountId = providerAccountId;
    record.updatedAt = new Date();
    return clone(record);
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    const record = this.rows.get(id);
    if (!record || record.workspaceId !== workspaceId) {
      return false;
    }
    this.rows.delete(id);
    return true;
  }
}
