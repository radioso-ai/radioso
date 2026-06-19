import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  SlackInstallationService,
  type SlackBindingRepositoryPort,
  type SlackInstallationRepositoryPort,
} from "../../../src/modules/slack/install/slackInstallationService.js";
import type {
  CreateIntegrationConnectionInput,
  IntegrationConnectionRecord,
  IntegrationConnectionRepositoryPort,
  UpdateIntegrationConnectionInput,
} from "../../../src/modules/integrationConnections/public.js";
import type {
  CreateOauthConnectionInput,
  OauthConnectionRecord,
  OauthConnectionRepositoryPort,
} from "../../../src/db/repositories/oauthConnectionRepository.js";
import { decryptOauthTokens } from "../../../src/modules/integrationOauth/public.js";

const encryptionKey = Buffer.alloc(32, 7).toString("base64");

class InMemoryOauthConnections implements Pick<OauthConnectionRepositoryPort, "create" | "findById" | "setOauthTokens"> {
  readonly rows = new Map<string, OauthConnectionRecord>();
  readonly created: CreateOauthConnectionInput[] = [];
  readonly tokenWrites: Array<{ workspaceId: string; id: string; credentialCiphertext: string; grantedScopes?: string[]; providerAccountId?: string | null }> = [];

  async create(input: CreateOauthConnectionInput): Promise<OauthConnectionRecord> {
    this.created.push(input);
    const now = new Date();
    const record: OauthConnectionRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      provider: input.provider,
      providerAccountId: input.providerAccountId ?? null,
      displayName: input.displayName,
      status: input.status ?? "pending",
      grantedScopes: input.grantedScopes ?? [],
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
    return { ...record };
  }

  async findById(workspaceId: string, id: string): Promise<OauthConnectionRecord | null> {
    const record = this.rows.get(id);
    return record && record.workspaceId === workspaceId ? { ...record } : null;
  }

  async setOauthTokens(
    workspaceId: string,
    id: string,
    credentialCiphertext: string,
    _encryptionKeyId: string | null,
    grantedScopes?: string[],
    providerAccountId?: string | null,
  ): Promise<OauthConnectionRecord | null> {
    this.tokenWrites.push({ workspaceId, id, credentialCiphertext, grantedScopes, providerAccountId });
    const existing = this.rows.get(id);
    if (!existing || existing.workspaceId !== workspaceId) return null;
    existing.credentialCiphertext = credentialCiphertext;
    existing.status = "authorized";
    existing.grantedScopes = grantedScopes ?? existing.grantedScopes;
    existing.providerAccountId = providerAccountId ?? existing.providerAccountId;
    existing.updatedAt = new Date();
    return { ...existing };
  }
}

class InMemoryIntegrationConnections implements IntegrationConnectionRepositoryPort {
  readonly rows = new Map<string, IntegrationConnectionRecord>();
  readonly created: CreateIntegrationConnectionInput[] = [];
  readonly updates: UpdateIntegrationConnectionInput[] = [];

  async create(input: CreateIntegrationConnectionInput): Promise<IntegrationConnectionRecord> {
    this.created.push(input);
    const now = new Date();
    const record: IntegrationConnectionRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      oauthConnectionId: input.oauthConnectionId,
      provider: input.provider,
      displayName: input.displayName,
      status: input.status ?? "authorized",
      lastHealthStatus: input.lastHealthStatus ?? null,
      lastHealthCheckedAt: input.lastHealthCheckedAt ?? null,
      lastErrorCode: input.lastErrorCode ?? null,
      config: input.config ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(record.id, record);
    return { ...record };
  }

  async findById(workspaceId: string, id: string): Promise<IntegrationConnectionRecord | null> {
    const record = this.rows.get(id);
    return record && record.workspaceId === workspaceId ? { ...record } : null;
  }

  async listByWorkspace(): Promise<IntegrationConnectionRecord[]> {
    return [];
  }

  async listByWorkspaceProvider(): Promise<IntegrationConnectionRecord[]> {
    return [];
  }

  async update(
    workspaceId: string,
    id: string,
    input: UpdateIntegrationConnectionInput,
  ): Promise<IntegrationConnectionRecord | null> {
    this.updates.push(input);
    const record = this.rows.get(id);
    if (!record || record.workspaceId !== workspaceId) return null;
    Object.assign(record, input);
    record.config = { ...record.config, ...(input.config ?? {}) };
    record.updatedAt = new Date();
    return { ...record };
  }

  async remove(): Promise<boolean> {
    return false;
  }
}

class InMemorySlackInstallations implements SlackInstallationRepositoryPort {
  readonly rows = new Map<string, Awaited<ReturnType<SlackInstallationRepositoryPort["upsert"]>>>();

  async findById(installationId: string) {
    return this.rows.get(installationId) ?? null;
  }

  async findByTeamId(teamId: string) {
    return [...this.rows.values()].find((record) => record.teamId === teamId) ?? null;
  }

  async findByWorkspaceId(workspaceId: string) {
    return [...this.rows.values()].find((record) => record.workspaceId === workspaceId) ?? null;
  }

  async upsert(input: Parameters<SlackInstallationRepositoryPort["upsert"]>[0]) {
    const existing = await this.findByTeamId(input.teamId);
    const now = new Date();
    const record = {
      id: existing?.id ?? randomUUID(),
      connectionId: input.connectionId,
      workspaceId: input.workspaceId,
      teamId: input.teamId,
      teamName: input.teamName ?? null,
      botUserId: input.botUserId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.rows.set(record.id, record);
    return record;
  }

  async removeByWorkspaceId(workspaceId: string): Promise<boolean> {
    const record = await this.findByWorkspaceId(workspaceId);
    if (!record) return false;
    this.rows.delete(record.id);
    return true;
  }
}

class InMemorySlackBindings implements SlackBindingRepositoryPort {
  readonly upserts: Parameters<SlackBindingRepositoryPort["upsert"]>[0][] = [];
  readonly rows = new Map<string, Awaited<ReturnType<SlackBindingRepositoryPort["upsert"]>>>();

  async findByInstallationId(installationId: string) {
    return [...this.rows.values()].find((record) => record.installationId === installationId) ?? null;
  }

  async upsert(input: Parameters<SlackBindingRepositoryPort["upsert"]>[0]) {
    this.upserts.push(input);
    const now = new Date();
    const existing = await this.findByInstallationId(input.installationId);
    const record = {
      id: existing?.id ?? randomUUID(),
      installationId: input.installationId,
      workspaceId: input.workspaceId,
      answeringAgentId: input.answeringAgentId,
      escalationChannelId: input.escalationChannelId ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.rows.set(record.id, record);
    return record;
  }

  async removeByInstallationId(installationId: string): Promise<boolean> {
    const record = await this.findByInstallationId(installationId);
    if (!record) return false;
    this.rows.delete(record.id);
    return true;
  }
}

const createService = () => {
  const oauthConnections = new InMemoryOauthConnections();
  const integrationConnections = new InMemoryIntegrationConnections();
  const installations = new InMemorySlackInstallations();
  const bindings = new InMemorySlackBindings();
  const service = new SlackInstallationService({
    oauthConnections,
    integrationConnections,
    installations,
    bindings,
    encryptionKey,
  });
  return { service, oauthConnections, integrationConnections, installations, bindings };
};

describe("SlackInstallationService", () => {
  it("creates an installation keyed by team id and stores the bot token through OAuth credentials", async () => {
    const { service, oauthConnections, integrationConnections, bindings } = createService();

    const result = await service.saveInstallation({
      workspaceId: "workspace-1",
      teamId: "T123",
      teamName: "Acme",
      botUserId: "U_BOT",
      botAccessToken: "xoxb-token",
      grantedScopes: ["chat:write", "im:read"],
      answeringAgentId: "agent-1",
      escalationChannelId: "C_ESC",
    });

    expect(result.installation).toMatchObject({ teamId: "T123", teamName: "Acme", botUserId: "U_BOT" });
    expect(oauthConnections.created).toMatchObject([{ provider: "slack", displayName: "Acme" }]);
    expect(integrationConnections.created).toMatchObject([{ provider: "slack", status: "authorized" }]);
    expect(bindings.upserts).toMatchObject([{ answeringAgentId: "agent-1", escalationChannelId: "C_ESC" }]);
    const ciphertext = oauthConnections.tokenWrites[0]?.credentialCiphertext;
    expect(ciphertext).toBeTypeOf("string");
    expect(JSON.stringify(oauthConnections.rows)).not.toContain("xoxb-token");
    expect(decryptOauthTokens(ciphertext!, encryptionKey)).toMatchObject({ accessToken: "xoxb-token" });
  });

  it("reinstalls by team id by refreshing the existing credential and binding", async () => {
    const { service, oauthConnections, integrationConnections, bindings } = createService();
    const first = await service.saveInstallation({
      workspaceId: "workspace-1",
      teamId: "T123",
      teamName: "Acme",
      botUserId: "U_BOT",
      botAccessToken: "xoxb-old",
      grantedScopes: ["chat:write"],
      answeringAgentId: "agent-1",
    });

    const updated = await service.saveInstallation({
      workspaceId: "workspace-1",
      teamId: "T123",
      teamName: "Acme renamed",
      botUserId: "U_BOT_2",
      botAccessToken: "xoxb-new",
      grantedScopes: ["chat:write", "im:read"],
      answeringAgentId: "agent-2",
    });

    expect(updated.installation.id).toBe(first.installation.id);
    expect(oauthConnections.created).toHaveLength(1);
    expect(oauthConnections.tokenWrites).toHaveLength(2);
    expect(integrationConnections.updates.at(-1)).toMatchObject({ displayName: "Acme renamed", status: "authorized" });
    expect(bindings.upserts.at(-1)).toMatchObject({ answeringAgentId: "agent-2" });
    expect(decryptOauthTokens(oauthConnections.tokenWrites.at(-1)!.credentialCiphertext, encryptionKey)).toMatchObject({
      accessToken: "xoxb-new",
    });
  });

  it("requires CONNECTOR_ENCRYPTION_KEY before storing Slack credentials", async () => {
    const { oauthConnections, integrationConnections, installations, bindings } = createService();
    const service = new SlackInstallationService({
      oauthConnections,
      integrationConnections,
      installations,
      bindings,
      encryptionKey: undefined,
    });

    await expect(service.saveInstallation({
      workspaceId: "workspace-1",
      teamId: "T123",
      botUserId: "U_BOT",
      botAccessToken: "xoxb-token",
      grantedScopes: [],
      answeringAgentId: "agent-1",
    })).rejects.toThrow("CONNECTOR_ENCRYPTION_KEY");
    expect(oauthConnections.created).toHaveLength(0);
  });
});
