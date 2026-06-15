import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  CreateCustomerEmailConnectionInput,
  CustomerEmailConnectionRecord,
  CustomerEmailConnectionRepositoryPort,
  UpdateCustomerEmailConnectionInput,
} from "../../../src/db/repositories/customerEmailConnectionRepository.js";
import type { CustomerEmailConnectionStatus } from "../../../src/modules/customerEmail/domain.js";
import { CustomerEmailConnectionService } from "../../../src/modules/customerEmail/services/customerEmailConnectionService.js";
import type { CustomerEmailProviderAdapter } from "../../../src/modules/customerEmail/providers/customerEmailProvider.js";
import type { OauthConnectionSummary } from "../../../src/modules/integrationOauth/public.js";

const now = new Date("2026-06-15T12:00:00.000Z");

const clone = (record: CustomerEmailConnectionRecord): CustomerEmailConnectionRecord => ({
  ...record,
  createdAt: new Date(record.createdAt),
  updatedAt: new Date(record.updatedAt),
  lastHealthCheckedAt: record.lastHealthCheckedAt ? new Date(record.lastHealthCheckedAt) : null,
});

class InMemoryCustomerEmailConnectionRepository implements CustomerEmailConnectionRepositoryPort {
  readonly records = new Map<string, CustomerEmailConnectionRecord>();
  referenceCount = 0;

  async create(input: CreateCustomerEmailConnectionInput): Promise<CustomerEmailConnectionRecord> {
    const record: CustomerEmailConnectionRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      oauthConnectionId: input.oauthConnectionId,
      provider: input.provider,
      displayName: input.displayName,
      senderEmail: input.senderEmail,
      senderName: input.senderName ?? null,
      replyToEmail: input.replyToEmail ?? null,
      status: input.status ?? "authorized",
      lastHealthStatus: input.lastHealthStatus ?? null,
      lastHealthCheckedAt: input.lastHealthCheckedAt ?? null,
      lastErrorCode: input.lastErrorCode ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(record.id, record);
    return clone(record);
  }

  async findById(workspaceId: string, id: string): Promise<CustomerEmailConnectionRecord | null> {
    const record = this.records.get(id);
    return record && record.workspaceId === workspaceId ? clone(record) : null;
  }

  async listByWorkspace(workspaceId: string): Promise<CustomerEmailConnectionRecord[]> {
    return [...this.records.values()].filter((record) => record.workspaceId === workspaceId).map(clone);
  }

  async update(
    workspaceId: string,
    id: string,
    input: UpdateCustomerEmailConnectionInput,
  ): Promise<CustomerEmailConnectionRecord | null> {
    const record = this.records.get(id);
    if (!record || record.workspaceId !== workspaceId) {
      return null;
    }
    if (input.displayName !== undefined) record.displayName = input.displayName;
    if (input.senderEmail !== undefined) record.senderEmail = input.senderEmail;
    if (input.senderName !== undefined) record.senderName = input.senderName;
    if (input.replyToEmail !== undefined) record.replyToEmail = input.replyToEmail;
    if (input.status !== undefined) record.status = input.status;
    if (input.lastHealthStatus !== undefined) record.lastHealthStatus = input.lastHealthStatus;
    if (input.lastHealthCheckedAt !== undefined) record.lastHealthCheckedAt = input.lastHealthCheckedAt;
    if (input.lastErrorCode !== undefined) record.lastErrorCode = input.lastErrorCode;
    record.updatedAt = now;
    return clone(record);
  }

  async countSkillReferences(workspaceId: string, id: string): Promise<number> {
    const record = this.records.get(id);
    return record && record.workspaceId === workspaceId ? this.referenceCount : 0;
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    const record = this.records.get(id);
    if (!record || record.workspaceId !== workspaceId) {
      return false;
    }
    this.records.delete(id);
    return true;
  }
}

const oauthSummary = (overrides: Partial<OauthConnectionSummary> = {}): OauthConnectionSummary => ({
  id: overrides.id ?? randomUUID(),
  provider: overrides.provider ?? "google_mail",
  displayName: overrides.displayName ?? "Support Gmail",
  status: overrides.status ?? "authorized",
  grantedScopes: overrides.grantedScopes ?? [
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.send",
  ],
  providerAccountId: overrides.providerAccountId ?? "support@example.com",
  updatedAt: overrides.updatedAt ?? now.toISOString(),
});

const createService = (options: {
  oauth?: OauthConnectionSummary;
  repository?: InMemoryCustomerEmailConnectionRepository;
  health?: Awaited<ReturnType<CustomerEmailProviderAdapter["checkHealth"]>>;
} = {}) => {
  const repository = options.repository ?? new InMemoryCustomerEmailConnectionRepository();
  const oauth = options.oauth ?? oauthSummary();
  const service = new CustomerEmailConnectionService({
    repository,
    oauthConnections: {
      get: async () => oauth,
    },
    providers: {
      get: (provider) =>
        provider === oauth.provider
          ? {
              provider,
              checkHealth: async () => options.health ?? { status: "ok" },
            }
          : null,
    },
  });
  return { service, repository, oauth };
};

describe("CustomerEmailConnectionService", () => {
  it("creates a connection only for an authorized OAuth mail connection with required scopes", async () => {
    const { service, oauth } = createService();

    const created = await service.create("workspace-1", {
      oauthConnectionId: oauth.id,
      displayName: "Support outbound",
      senderEmail: "support@example.com",
      senderName: "Example Support",
      replyToEmail: "reply@example.com",
    });

    expect(created).toMatchObject({
      oauthConnectionId: oauth.id,
      provider: "google_mail",
      displayName: "Support outbound",
      senderEmail: "support@example.com",
      senderName: "Example Support",
      replyToEmail: "reply@example.com",
      status: "authorized",
    });
    expect(JSON.stringify(created)).not.toContain("access");
  });

  it("rejects unauthorized OAuth connections and missing mail scopes", async () => {
    await expect(
      createService({ oauth: oauthSummary({ status: "needs_reauth" }) }).service.create("workspace-1", {
        oauthConnectionId: randomUUID(),
        displayName: "Broken",
        senderEmail: "support@example.com",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    await expect(
      createService({ oauth: oauthSummary({ grantedScopes: ["https://www.googleapis.com/auth/gmail.send"] }) })
        .service.create("workspace-1", {
          oauthConnectionId: randomUUID(),
          displayName: "Missing compose",
          senderEmail: "support@example.com",
        }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("disables and re-enables without deleting referenced connections", async () => {
    const { service, repository, oauth } = createService();
    const created = await service.create("workspace-1", {
      oauthConnectionId: oauth.id,
      displayName: "Support",
      senderEmail: "support@example.com",
    });

    const disabled = await service.update("workspace-1", created.id, { disabled: true });
    expect(disabled.status).toBe("disabled");

    repository.referenceCount = 2;
    await expect(service.remove("workspace-1", created.id)).rejects.toMatchObject({
      statusCode: 409,
      code: "conflict",
    });

    const reenabled = await service.update("workspace-1", created.id, { disabled: false });
    expect(reenabled.status).toBe<CustomerEmailConnectionStatus>("authorized");
  });

  it("marks re-enabled or health-checked connections as needs_reauth when OAuth is stale", async () => {
    const repository = new InMemoryCustomerEmailConnectionRepository();
    const authorized = oauthSummary();
    const created = await createService({ repository, oauth: authorized }).service.create("workspace-1", {
      oauthConnectionId: authorized.id,
      displayName: "Support",
      senderEmail: "support@example.com",
    });

    const staleService = createService({
      repository,
      oauth: oauthSummary({ id: authorized.id, status: "needs_reauth" }),
    }).service;

    const reenabled = await staleService.update("workspace-1", created.id, { disabled: false });
    expect(reenabled.status).toBe("needs_reauth");

    const health = await staleService.checkHealth("workspace-1", created.id);
    expect(health).toMatchObject({
      status: "needs_reauth",
      lastHealthStatus: "failed",
      lastErrorCode: "oauth_needs_reauth",
    });
  });

  it("records sanitized provider health failures", async () => {
    const { service, oauth } = createService({
      health: { status: "failed", errorCode: "provider_unavailable" },
    });
    const created = await service.create("workspace-1", {
      oauthConnectionId: oauth.id,
      displayName: "Support",
      senderEmail: "support@example.com",
    });

    const checked = await service.checkHealth("workspace-1", created.id);

    expect(checked).toMatchObject({
      status: "error",
      lastHealthStatus: "failed",
      lastErrorCode: "provider_unavailable",
    });
  });
});
