import { describe, expect, it, vi } from "vitest";

import { createIngestionSettingsCopilotProposalAdapter } from "../../../src/modules/operatorCopilot/ingestionSettingsProposalAdapter.js";
import { createIngestionSettingsProposalCopilotTools } from "../../../src/modules/operatorCopilot/tools/ingestionSettingsProposals.js";

const context = {
  workspaceId: "workspace-1",
  accountId: "account-1",
  operatorUserId: "operator-1",
  currentAuthorization: { hasAllPermissions: vi.fn(async () => true) },
  copilotConversationId: "conversation-1",
  pageContext: { view: "other" as const, agentId: null, conversationId: null, selection: null, entities: [] },
};

const storedSettings = (overrides: Record<string, unknown> = {}) => ({
  workspaceId: "workspace-1",
  chunkingStrategy: "fixed_window" as const,
  fixedWindowChunkSize: 1_000,
  fixedWindowChunkOverlap: 100,
  structuredMinChunkSize: 200,
  structuredMaxChunkSize: 2_000,
  embeddingModel: "text-embedding-3-small",
  pendingEmbeddingModel: null,
  documentEnrichmentEnabled: false,
  manualDocumentEnrichmentOverride: "inherit",
  updatedAt: new Date("2026-08-30T10:00:00.000Z"),
  ...overrides,
});

const settingsPorts = (settings = storedSettings()) => ({
  getForWorkspace: vi.fn(async () => settings),
  updateForWorkspace: vi.fn(async () => settings),
});

const adapterFor = (settings = settingsPorts()) => ({
  adapter: createIngestionSettingsCopilotProposalAdapter({ ingestionSettings: settings }),
  settings,
});

const toolFor = (adapter: ReturnType<typeof createIngestionSettingsCopilotProposalAdapter>) => {
  const createProposal = vi.fn(async (input: Record<string, unknown>) => ({
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    ...input,
  }) as never);
  const record = vi.fn(async () => undefined);
  const [descriptor] = createIngestionSettingsProposalCopilotTools({
    proposalRepository: { createProposal },
    proposalAdapters: [adapter],
    auditService: { record },
  });
  if (!descriptor) throw new Error("No ingestion settings proposal descriptor");
  return { descriptor, createProposal, record };
};

describe("propose_ingestion_settings", () => {
  it("expands a one-field change against the stored settings, because the write is a whole-object replace", async () => {
    const { adapter, settings } = adapterFor();
    const { descriptor, createProposal } = toolFor(adapter);

    await descriptor.createTool(context).invoke({
      fixedWindowChunkSize: 1_500,
      rationale: "Answers keep truncating mid-procedure.",
    }, {} as never);

    expect(settings.getForWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({
      targetType: "ingestion_settings",
      targetRef: {},
      versionToken: "2026-08-30T10:00:00.000Z",
      payload: expect.objectContaining({
        chunkingStrategy: "fixed_window",
        fixedWindowChunkSize: 1_500,
        fixedWindowChunkOverlap: 100,
        structuredMinChunkSize: 200,
        structuredMaxChunkSize: 2_000,
      }),
    }));
  });

  it("has no embedding model field, so the bulk re-embed stays outside a proposal card", () => {
    const { adapter } = adapterFor();
    const { descriptor } = toolFor(adapter);

    expect(descriptor.inputSchema.safeParse({ embeddingModel: "text-embedding-3-large" }).success).toBe(false);
  });

  it("refuses a proposal that changes nothing", async () => {
    const { adapter } = adapterFor();
    const { descriptor } = toolFor(adapter);

    await expect(descriptor.createTool(context).invoke({ rationale: "No change." }, {} as never))
      .rejects.toThrow(/at least one/i);
  });

  it("refuses a proposal whose values match what is already stored", async () => {
    const { adapter } = adapterFor();
    const { descriptor } = toolFor(adapter);

    await expect(descriptor.createTool(context).invoke({ fixedWindowChunkSize: 1_000 }, {} as never))
      .rejects.toThrow(/already/i);
  });
});

describe("ingestion settings proposal adapter", () => {
  it("writes the merged settings when the stored version still matches", async () => {
    const { adapter, settings } = adapterFor();

    const outcome = await adapter.applyIfVersionMatches("workspace-1", {}, {
      chunkingStrategy: "fixed_window",
      fixedWindowChunkSize: 1_500,
      fixedWindowChunkOverlap: 100,
      structuredMinChunkSize: 200,
      structuredMaxChunkSize: 2_000,
    }, "2026-08-30T10:00:00.000Z");

    expect(settings.updateForWorkspace).toHaveBeenCalledWith("workspace-1", expect.objectContaining({ fixedWindowChunkSize: 1_500 }));
    expect(outcome).toEqual({ outcome: "applied", appliedRef: { workspaceId: "workspace-1" } });
  });

  it("refuses a payload naming an embedding model outright, so applying can never start a re-embed", async () => {
    const { adapter, settings } = adapterFor();

    await expect(adapter.applyIfVersionMatches("workspace-1", {}, {
      chunkingStrategy: "fixed_window",
      fixedWindowChunkSize: 1_500,
      fixedWindowChunkOverlap: 100,
      structuredMinChunkSize: 200,
      structuredMaxChunkSize: 2_000,
      embeddingModel: "text-embedding-3-large",
    }, "2026-08-30T10:00:00.000Z")).rejects.toThrow(/embeddingModel/);

    expect(settings.updateForWorkspace).not.toHaveBeenCalled();
  });

  it("reports a settings change as stale when the settings moved under the draft", async () => {
    const { adapter, settings } = adapterFor();

    const outcome = await adapter.applyIfVersionMatches("workspace-1", {}, {
      chunkingStrategy: "fixed_window",
      fixedWindowChunkSize: 1_500,
      fixedWindowChunkOverlap: 100,
      structuredMinChunkSize: 200,
      structuredMaxChunkSize: 2_000,
    }, "2026-08-01T10:00:00.000Z");

    expect(outcome).toEqual({ outcome: "stale" });
    expect(settings.updateForWorkspace).not.toHaveBeenCalled();
  });

  it("previews only the fields the proposal changes against their stored values", async () => {
    const { adapter } = adapterFor();

    const preview = await adapter.preview("workspace-1", {}, {
      chunkingStrategy: "fixed_window",
      fixedWindowChunkSize: 1_500,
      fixedWindowChunkOverlap: 100,
      structuredMinChunkSize: 200,
      structuredMaxChunkSize: 2_000,
    });

    expect(preview.targetLabel).toBe("Ingestion settings");
    expect(preview.current).toMatchObject({ fixedWindowChunkSize: 1_000 });
    expect(preview.proposed).toMatchObject({ fixedWindowChunkSize: 1_500 });
  });
});
