import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  decryptField,
  encryptField,
} from "../../src/shared/infra/crypto/fieldEncryption.js";
import {
  WorkspaceProviderCredentialsService,
  type WorkspaceCredentialsEncryptionConfig,
} from "../../src/modules/security/credentials/services/workspaceProviderCredentialsService.js";
import type {
  WorkspaceProviderCredentialRecord,
  WorkspaceProviderCredentialSummary,
  WorkspaceProviderCredentialsRepositoryPort,
} from "../../src/db/repositories/workspaceProviderCredentialsRepository.js";
import type { AuditPort } from "../../src/modules/audit/contracts/index.js";
import type { LlmProviderName } from "../../src/shared/infra/llm/providerTypes.js";

const TEST_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
const WORKSPACE_ID = "ws-1";

const createRepository = (): WorkspaceProviderCredentialsRepositoryPort & {
  rows: Map<string, WorkspaceProviderCredentialRecord>;
} => {
  const rows = new Map<string, WorkspaceProviderCredentialRecord>();
  return {
    rows,
    async findByWorkspaceAndProvider(workspaceId, provider) {
      return rows.get(`${workspaceId}:${provider}`) ?? null;
    },
    async listByWorkspace(workspaceId): Promise<WorkspaceProviderCredentialSummary[]> {
      return [...rows.values()]
        .filter((r) => r.workspaceId === workspaceId)
        .map((r) => ({ workspaceId: r.workspaceId, provider: r.provider, updatedAt: r.updatedAt }));
    },
    async upsert(input) {
      const existing = rows.get(`${input.workspaceId}:${input.provider}`);
      const record: WorkspaceProviderCredentialRecord = {
        workspaceId: input.workspaceId,
        provider: input.provider,
        ciphertext: input.ciphertext,
        createdAt: existing?.createdAt ?? new Date(),
        updatedAt: new Date(),
      };
      rows.set(`${input.workspaceId}:${input.provider}`, record);
      return record;
    },
    async remove(workspaceId, provider) {
      return rows.delete(`${workspaceId}:${provider}`);
    },
  };
};

const createAudit = (): AuditPort & { events: Array<{ eventType: string; eventStatus: string; metadata?: Record<string, unknown> }> } => {
  const events: Array<{ eventType: string; eventStatus: string; metadata?: Record<string, unknown> }> = [];
  return {
    events,
    async record(input) {
      events.push({
        eventType: input.eventType,
        eventStatus: input.eventStatus,
        metadata: input.metadata as Record<string, unknown> | undefined,
      });
    },
    async getLatestSuccessfulChatAnswerMetadata() {
      return null;
    },
    async updateChatAnswerSuggestions() {
      return;
    },
  };
};

const configWithKey: WorkspaceCredentialsEncryptionConfig = {
  key: TEST_KEY,
};

const configMissingKey: WorkspaceCredentialsEncryptionConfig = {
  key: undefined,
};

describe("WorkspaceProviderCredentialsService", () => {
  describe("with encryption configured", () => {
    let repo: ReturnType<typeof createRepository>;
    let audit: ReturnType<typeof createAudit>;
    let service: WorkspaceProviderCredentialsService;

    beforeEach(() => {
      repo = createRepository();
      audit = createAudit();
      service = new WorkspaceProviderCredentialsService(repo, audit, configWithKey);
    });

    it("encrypts the api key before persisting it", async () => {
      await service.setApiKey({
        workspaceId: WORKSPACE_ID,
        provider: "openai",
        apiKey: "sk-test-1234567890",
        actor: { accountId: "acc-1" },
      });

      const stored = repo.rows.get(`${WORKSPACE_ID}:openai`);
      expect(stored).toBeDefined();
      expect(stored?.ciphertext).not.toContain("sk-test");
      expect(decryptField(stored!.ciphertext, TEST_KEY)).toBe("sk-test-1234567890");
    });

    it("retrieves and decrypts a stored api key", async () => {
      await service.setApiKey({
        workspaceId: WORKSPACE_ID,
        provider: "claude",
        apiKey: "claude-key",
        actor: { accountId: "acc-1" },
      });

      const key = await service.getApiKey(WORKSPACE_ID, "claude");
      expect(key).toBe("claude-key");
    });

    it("returns undefined when no credential exists", async () => {
      const key = await service.getApiKey(WORKSPACE_ID, "gemini");
      expect(key).toBeUndefined();
    });

    it("overwrites an existing key on a second set", async () => {
      await service.setApiKey({
        workspaceId: WORKSPACE_ID,
        provider: "openai",
        apiKey: "first",
        actor: { accountId: "acc-1" },
      });
      await service.setApiKey({
        workspaceId: WORKSPACE_ID,
        provider: "openai",
        apiKey: "second",
        actor: { accountId: "acc-1" },
      });

      const key = await service.getApiKey(WORKSPACE_ID, "openai");
      expect(key).toBe("second");
    });

    it("trims surrounding whitespace before encrypting and storing", async () => {
      await service.setApiKey({
        workspaceId: WORKSPACE_ID,
        provider: "openai",
        apiKey: "  sk-with-padding-1234\n",
        actor: { accountId: "acc-1" },
      });

      const stored = repo.rows.get(`${WORKSPACE_ID}:openai`);
      expect(decryptField(stored!.ciphertext, TEST_KEY)).toBe("sk-with-padding-1234");
    });

    it("rejects empty api keys", async () => {
      await expect(
        service.setApiKey({
          workspaceId: WORKSPACE_ID,
          provider: "openai",
          apiKey: "",
          actor: { accountId: "acc-1" },
        }),
      ).rejects.toThrow(/api key/i);
    });

    it("removes a credential and reports whether anything was deleted", async () => {
      await service.setApiKey({
        workspaceId: WORKSPACE_ID,
        provider: "openai",
        apiKey: "key",
        actor: { accountId: "acc-1" },
      });

      const removed = await service.removeApiKey(WORKSPACE_ID, "openai", { accountId: "acc-1" });
      expect(removed).toBe(true);
      expect(await service.getApiKey(WORKSPACE_ID, "openai")).toBeUndefined();

      const removedAgain = await service.removeApiKey(WORKSPACE_ID, "openai", { accountId: "acc-1" });
      expect(removedAgain).toBe(false);
    });

    it("lists configured providers without exposing key material", async () => {
      await service.setApiKey({
        workspaceId: WORKSPACE_ID,
        provider: "openai",
        apiKey: "sk-openai",
        actor: { accountId: "acc-1" },
      });
      await service.setApiKey({
        workspaceId: WORKSPACE_ID,
        provider: "claude",
        apiKey: "claude-key",
        actor: { accountId: "acc-1" },
      });

      const list = await service.listConfigured(WORKSPACE_ID);
      expect(list.map((entry) => entry.provider).sort()).toEqual(["claude", "openai"]);
      for (const entry of list) {
        expect(entry).not.toHaveProperty("ciphertext");
        expect(entry).not.toHaveProperty("apiKey");
      }
    });

    it("emits audit events on set and remove without including key material", async () => {
      await service.setApiKey({
        workspaceId: WORKSPACE_ID,
        provider: "openai",
        apiKey: "sk-secret",
        actor: { accountId: "acc-1" },
      });
      await service.removeApiKey(WORKSPACE_ID, "openai", { accountId: "acc-1" });

      const eventTypes = audit.events.map((e) => `${e.eventType}:${e.eventStatus}`);
      expect(eventTypes).toContain("workspace_provider_credentials.set:success");
      expect(eventTypes).toContain("workspace_provider_credentials.remove:success");
      for (const event of audit.events) {
        expect(JSON.stringify(event)).not.toContain("sk-secret");
      }
    });

    it("reports that encryption is configured", () => {
      expect(service.isEncryptionConfigured()).toBe(true);
    });
  });

  describe("without encryption configured", () => {
    let repo: ReturnType<typeof createRepository>;
    let audit: ReturnType<typeof createAudit>;
    let service: WorkspaceProviderCredentialsService;

    beforeEach(() => {
      repo = createRepository();
      audit = createAudit();
      service = new WorkspaceProviderCredentialsService(repo, audit, configMissingKey);
    });

    it("reports that encryption is not configured", () => {
      expect(service.isEncryptionConfigured()).toBe(false);
    });

    it("rejects writes with a clear error", async () => {
      await expect(
        service.setApiKey({
          workspaceId: WORKSPACE_ID,
          provider: "openai",
          apiKey: "key",
          actor: { accountId: "acc-1" },
        }),
      ).rejects.toThrow(/CONNECTOR_ENCRYPTION_KEY/);
    });

    it("still allows listing configured providers (read-only inventory)", async () => {
      const list = await service.listConfigured(WORKSPACE_ID);
      expect(list).toEqual([]);
    });

    it("returns undefined for getApiKey when no row exists (env fallback is intentional)", async () => {
      await expect(service.getApiKey(WORKSPACE_ID, "openai" satisfies LlmProviderName)).resolves.toBeUndefined();
    });

    it("throws when a row exists but encryption is not configured (do not silently fall back to env)", async () => {
      const repo = createRepository();
      const audit = createAudit();
      const writerService = new WorkspaceProviderCredentialsService(repo, audit, configWithKey);
      await writerService.setApiKey({
        workspaceId: WORKSPACE_ID,
        provider: "openai",
        apiKey: "key",
        actor: { accountId: "acc-1" },
      });

      const reader = new WorkspaceProviderCredentialsService(repo, audit, configMissingKey);
      const failure = await reader.getApiKey(WORKSPACE_ID, "openai" satisfies LlmProviderName).catch((error) => error);
      expect(failure).toMatchObject({
        statusCode: 503,
        code: "provider_misconfigured",
        details: { providerIssue: "configuration_invalid", kind: "credential_unreadable", provider: "openai" },
      });
    });
  });

  describe("decrypt failures", () => {
    it("throws a provider_misconfigured 503 instead of silently falling back to env", async () => {
      const repo = createRepository();
      const audit = createAudit();
      const wrongKey = Buffer.from("ffffffffffffffffffffffffffffffff").toString("base64");
      const writerService = new WorkspaceProviderCredentialsService(repo, audit, configWithKey);
      await writerService.setApiKey({
        workspaceId: WORKSPACE_ID,
        provider: "openai",
        apiKey: "key",
        actor: { accountId: "acc-1" },
      });

      const reader = new WorkspaceProviderCredentialsService(repo, audit, { key: wrongKey });
      const onErrorSpy = vi.fn();
      reader.onDecryptError(onErrorSpy);
      const failure = await reader.getApiKey(WORKSPACE_ID, "openai").catch((error) => error);
      expect(failure).toMatchObject({
        statusCode: 503,
        code: "provider_misconfigured",
        details: {
          providerIssue: "configuration_invalid",
          kind: "credential_unreadable",
          provider: "openai",
          remediation: expect.stringMatching(/re-enter|restore/i),
        },
      });
      expect(onErrorSpy).toHaveBeenCalledOnce();
    });
  });

  describe("guard rails", () => {
    it("uses the existing field encryption helper so ciphertext format matches", () => {
      // Sanity: encryption helper round-trips with the same key.
      const enc = encryptField("hi", TEST_KEY, { keyName: "CONNECTOR_ENCRYPTION_KEY" });
      expect(decryptField(enc, TEST_KEY)).toBe("hi");
    });
  });
});
