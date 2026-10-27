import { describe, expect, it, vi } from "vitest";

import { WorkspaceLlmCapabilitySettingsService } from "../../src/modules/settings/services/workspaceLlmCapabilitySettingsService.js";
import type {
  WorkspaceLlmCapability,
  WorkspaceLlmCapabilityPreference,
  WorkspaceLlmCapabilityPreferenceInput,
} from "../../src/modules/settings/contracts/llmCapability.js";
import type {
  WorkspaceLlmCapabilityPreferencesRepositoryPort,
} from "../../src/modules/settings/contracts/services.js";
import type { AuditPort } from "../../src/modules/audit/contracts/index.js";
import type { WorkspaceModelAvailability } from "../../src/shared/domain/workspaceModelAvailability.js";
import type { LlmProviderName } from "../../src/shared/infra/llm/providerTypes.js";
import { knownModelsByProvider } from "../../src/shared/infra/llm/knownModels.js";

const createRepository = (): WorkspaceLlmCapabilityPreferencesRepositoryPort & {
  rows: Map<string, Map<WorkspaceLlmCapability, WorkspaceLlmCapabilityPreference>>;
  ensuredRows: string[];
} => {
  const rows = new Map<string, Map<WorkspaceLlmCapability, WorkspaceLlmCapabilityPreference>>();
  const ensuredRows: string[] = [];
  return {
    rows,
    ensuredRows,
    async ensureRow(workspaceId) {
      ensuredRows.push(workspaceId);
    },
    async findByWorkspace(workspaceId) {
      return rows.get(workspaceId) ? [...rows.get(workspaceId)!.values()] : [];
    },
    async setPreference(workspaceId, capability, input) {
      const row = rows.get(workspaceId) ?? new Map<WorkspaceLlmCapability, WorkspaceLlmCapabilityPreference>();
      if (input === null) {
        row.delete(capability);
      } else {
        row.set(capability, {
          workspaceId,
          capability,
          provider: input.provider,
          model: input.model,
          updatedAt: new Date(),
        });
      }
      rows.set(workspaceId, row);
    },
  };
};

type AuditEvent = {
  eventType: string;
  eventStatus: string;
  metadata?: Record<string, unknown>;
};

const createAudit = (): AuditPort & { events: AuditEvent[] } => {
  const events: AuditEvent[] = [];
  return {
    events,
    async record(input) {
      events.push({
        eventType: input.eventType,
        eventStatus: input.eventStatus,
        metadata: input.metadata,
      });
    },
    async recordForLiveConversation() {},
    async getLatestSuccessfulChatAnswerMetadata() {
      return null;
    },
    async updateChatAnswerSuggestions() {},
  };
};

const createThrowingAudit = (): AuditPort => ({
  async record() {
    throw new Error("audit pipeline down");
  },
  async recordForLiveConversation() {},
  async getLatestSuccessfulChatAnswerMetadata() {
    return null;
  },
  async updateChatAnswerSuggestions() {},
});

const validInput: WorkspaceLlmCapabilityPreferenceInput = { provider: "openai", model: "gpt-5-mini" };

describe("WorkspaceLlmCapabilitySettingsService", () => {
  it("returns an empty list when no preferences are stored", async () => {
    const repo = createRepository();
    const service = new WorkspaceLlmCapabilitySettingsService(repo, createAudit());
    expect(await service.listForWorkspace("ws-1")).toEqual([]);
  });

  it("stores a preference and reports it back", async () => {
    const repo = createRepository();
    const service = new WorkspaceLlmCapabilitySettingsService(repo, createAudit());

    await service.setPreference("ws-1", "chat", { provider: "claude", model: "claude-sonnet-4-5" }, { accountId: "acc-1" });

    const list = await service.listForWorkspace("ws-1");
    expect(list).toEqual([
      expect.objectContaining({ capability: "chat", provider: "claude", model: "claude-sonnet-4-5" }),
    ]);
  });

  it("ensures the retrieval_settings row exists before writing", async () => {
    const repo = createRepository();
    const service = new WorkspaceLlmCapabilitySettingsService(repo, createAudit());

    await service.setPreference("ws-1", "chat", validInput, { accountId: "acc-1" });

    expect(repo.ensuredRows).toEqual(["ws-1"]);
  });

  it("emits audit events on set and remove", async () => {
    const repo = createRepository();
    const audit = createAudit();
    const service = new WorkspaceLlmCapabilitySettingsService(repo, audit);

    await service.setPreference("ws-1", "rerank", { provider: "openai", model: "gpt-5-mini" }, { accountId: "acc-1" });
    await service.removePreference("ws-1", "rerank", { accountId: "acc-1" });

    const types = audit.events.map((e) => `${e.eventType}:${e.eventStatus}`);
    expect(types).toContain("workspace_llm_capability_settings.set:success");
    expect(types).toContain("workspace_llm_capability_settings.remove:success");
  });

  it("returns true on remove only when something was deleted", async () => {
    const repo = createRepository();
    const service = new WorkspaceLlmCapabilitySettingsService(repo, createAudit());

    await service.setPreference("ws-1", "chat", { provider: "openai", model: "gpt-5-mini" }, { accountId: "acc-1" });
    const first = await service.removePreference("ws-1", "chat", { accountId: "acc-1" });
    const second = await service.removePreference("ws-1", "chat", { accountId: "acc-1" });

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("rejects an unknown provider before touching the repository", async () => {
    const repo = createRepository();
    const service = new WorkspaceLlmCapabilitySettingsService(repo, createAudit());

    await expect(
      service.setPreference(
        "ws-1",
        "chat",
        { provider: "bogus" as unknown as "openai", model: "gpt-5.2" },
        { accountId: "acc-1" },
      ),
    ).rejects.toThrow();
    expect(repo.rows.size).toBe(0);
  });

  it("rejects an empty model string", async () => {
    const repo = createRepository();
    const service = new WorkspaceLlmCapabilitySettingsService(repo, createAudit());

    await expect(
      service.setPreference("ws-1", "chat", { provider: "openai", model: "" }, { accountId: "acc-1" }),
    ).rejects.toThrow();
  });

  it("getPreference returns the single capability preference or null", async () => {
    const repo = createRepository();
    const service = new WorkspaceLlmCapabilitySettingsService(repo, createAudit());

    await service.setPreference("ws-1", "chat", { provider: "claude", model: "claude-sonnet-4-5" }, { accountId: "acc-1" });

    const chat = await service.getPreference("ws-1", "chat");
    const rerank = await service.getPreference("ws-1", "rerank");

    expect(chat).toMatchObject({ provider: "claude", model: "claude-sonnet-4-5" });
    expect(rerank).toBeNull();
  });

  it("tags the set-failure audit with reason: write_failed so operators can tell modes apart", async () => {
    const repo = createRepository();
    const audit = createAudit();
    // Simulate a repo write failure so we exercise the failure-audit path.
    const writeError = new Error("db down");
    const failingRepo: typeof repo = {
      ...repo,
      setPreference: () => { throw writeError; },
    };
    const service = new WorkspaceLlmCapabilitySettingsService(failingRepo, audit);

    await expect(
      service.setPreference("ws-1", "chat", validInput, { accountId: "acc-1" }),
    ).rejects.toBe(writeError);

    const failure = audit.events.find((event) => event.eventStatus === "failure");
    expect(failure).toMatchObject({
      eventType: "workspace_llm_capability_settings.set",
      metadata: expect.objectContaining({ reason: "write_failed" }),
    });
  });

  it("emits a failure audit on removePreference when the write throws", async () => {
    const repo = createRepository();
    // Seed an existing preference so removePreference reaches the write path.
    await repo.ensureRow("ws-1");
    await repo.setPreference("ws-1", "chat", { provider: "claude", model: "claude-sonnet-4-5" });
    const writeError = new Error("db down");
    const failingRepo: typeof repo = {
      ...repo,
      setPreference: () => { throw writeError; },
    };
    const audit = createAudit();
    const service = new WorkspaceLlmCapabilitySettingsService(failingRepo, audit);

    await expect(
      service.removePreference("ws-1", "chat", { accountId: "acc-1" }),
    ).rejects.toBe(writeError);

    const failure = audit.events.find((event) => event.eventStatus === "failure");
    expect(failure).toMatchObject({
      eventType: "workspace_llm_capability_settings.remove",
      metadata: expect.objectContaining({ reason: "write_failed" }),
    });
  });

  it("logs a warn when the audit pipeline itself fails, instead of silently swallowing", async () => {
    const repo = createRepository();
    const warn = vi.fn();
    const service = new WorkspaceLlmCapabilitySettingsService(
      repo,
      createThrowingAudit(),
      { warn },
    );

    await service.setPreference("ws-1", "chat", validInput, { accountId: "acc-1" });

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "workspace_llm_capability_settings.set",
        eventStatus: "success",
        capability: "chat",
      }),
      "Workspace LLM capability settings audit write failed",
    );
  });
});

describe("WorkspaceLlmCapabilitySettingsService platform model availability", () => {
  // The staging shape: the platform openai key is an Azure key with one chat deployment, and the
  // workspace holds no openai key of its own.
  const azureOnly = (runnable: Partial<Record<LlmProviderName, readonly string[] | null>>): WorkspaceModelAvailability => ({
    runnableModels: vi.fn(async (_workspaceId: string, provider: LlmProviderName) => runnable[provider] ?? null),
    canRun: vi.fn(async (_workspaceId: string, provider: LlmProviderName, model: string) =>
      (runnable[provider] ?? null)?.includes(model) ?? true),
  });

  it("rejects a model the workspace cannot run, naming the runnable models and the own-key alternative", async () => {
    const repo = createRepository();
    const audit = createAudit();
    const service = new WorkspaceLlmCapabilitySettingsService(repo, audit, undefined, azureOnly({ openai: ["gpt-5.4-mini"] }));

    const attempt = service.setPreference("ws-1", "chat", { provider: "openai", model: "gpt-5.4-nano" }, { accountId: "acc-1" });

    await expect(attempt).rejects.toMatchObject({ statusCode: 400 });
    await expect(attempt).rejects.toThrow(/gpt-5\.4-nano[\s\S]*gpt-5\.4-mini[\s\S]*own openai API key/);
    expect(repo.rows.size).toBe(0);
    expect(audit.events).toEqual([]);
  });

  it("accepts any catalog model when the workspace can run every model the provider offers", async () => {
    const repo = createRepository();
    const service = new WorkspaceLlmCapabilitySettingsService(repo, createAudit(), undefined, azureOnly({ openai: null }));

    await service.setPreference("ws-1", "chat", { provider: "openai", model: "gpt-5.4-nano" }, { accountId: "acc-1" });

    expect(await service.getPreference("ws-1", "chat")).toMatchObject({ provider: "openai", model: "gpt-5.4-nano" });
  });

  it("keeps a stored model readable and re-writable after it stops being runnable", async () => {
    const repo = createRepository();
    await repo.setPreference("ws-1", "chat", { provider: "openai", model: "gpt-5.4-nano" });
    const service = new WorkspaceLlmCapabilitySettingsService(repo, createAudit(), undefined, azureOnly({ openai: ["gpt-5.4-mini"] }));

    expect(await service.listForWorkspace("ws-1")).toEqual([
      expect.objectContaining({ capability: "chat", provider: "openai", model: "gpt-5.4-nano" }),
    ]);
    await expect(
      service.setPreference("ws-1", "chat", { provider: "openai", model: " gpt-5.4-nano " }, { accountId: "acc-1" }),
    ).resolves.toMatchObject({ model: "gpt-5.4-nano" });
  });

  it("lists, per provider, the models this workspace can run, and the whole catalog where nothing restricts it", async () => {
    const service = new WorkspaceLlmCapabilitySettingsService(
      createRepository(),
      createAudit(),
      undefined,
      azureOnly({ openai: ["gpt-5.4-mini"] }),
    );

    const runnable = await service.runnableModelsByProvider("ws-1");

    expect(runnable).toEqual({
      openai: ["gpt-5.4-mini"],
      "openai-compatible": [],
      gemini: [...knownModelsByProvider.gemini],
      claude: [...knownModelsByProvider.claude],
    });
  });

  it("lists the whole catalog when no availability is wired (a deployment that serves every model)", async () => {
    const service = new WorkspaceLlmCapabilitySettingsService(createRepository(), createAudit());

    expect((await service.runnableModelsByProvider("ws-1")).openai).toEqual([...knownModelsByProvider.openai]);
  });
});
