import { describe, expect, it, vi } from "vitest";

import { createIngestionSettingsCopilotProposalAdapter } from "../../../src/modules/operatorCopilot/ingestionSettingsProposalAdapter.js";
import { OperatorMcpCatalogService } from "../../../src/modules/operatorCopilot/mcpCatalog.js";
import { operatorMcpDispositions } from "../../../src/modules/operatorCopilot/operatorMcpDisposition.js";
import { createIngestionSettingsProposalCopilotTools } from "../../../src/modules/operatorCopilot/tools/ingestionSettingsProposals.js";
import { badRequest } from "../../../src/shared/domain/errors.js";
import type { CopilotIngestionSettingsPort } from "../../../src/modules/operatorCopilot/contracts/ingestionSettingsAuthoring.js";

const context = {
  workspaceId: "workspace-1",
  accountId: "account-1",
  operatorUserId: "operator-1",
  surface: "dashboard" as const,
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

type SettingsPortMock = CopilotIngestionSettingsPort & {
  applyFieldProposal: ReturnType<typeof vi.fn>;
};

const settingsPorts = (settings = storedSettings()): SettingsPortMock => {
  const surface = () => ({
    chunkingStrategy: settings.chunkingStrategy,
    fixedWindowChunkSize: settings.fixedWindowChunkSize,
    fixedWindowChunkOverlap: settings.fixedWindowChunkOverlap,
    structuredMinChunkSize: settings.structuredMinChunkSize,
    structuredMaxChunkSize: settings.structuredMaxChunkSize,
    documentEnrichmentEnabled: settings.documentEnrichmentEnabled,
    manualDocumentEnrichmentOverride: settings.manualDocumentEnrichmentOverride,
  });
  return {
    prepareFieldProposal: vi.fn(async (_workspaceId, patch) => {
      const named = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
      if (Object.keys(named).length === 0) throw badRequest("Name at least one ingestion setting to change");
      const current = surface();
      const normalized = { ...current, ...named };
      if (normalized.fixedWindowChunkOverlap >= normalized.fixedWindowChunkSize) throw badRequest("Overlap must be smaller than window");
      const changed = Object.keys(normalized).filter((key) => normalized[key as keyof typeof normalized] !== current[key as keyof typeof current]);
      if (changed.length === 0) throw badRequest("The ingestion settings already hold these values");
      return { normalizedPatch: normalized, expected: Object.fromEntries(changed.map((key) => [key, current[key as keyof typeof current]])), display: { current, proposed: normalized } };
    }),
    readFieldProposalVersion: vi.fn(async () => "fields:test"),
    readFieldProposalDisplay: vi.fn(async () => surface()),
    applyFieldProposal: vi.fn(async () => ({ status: "applied" as const })),
  } as unknown as SettingsPortMock;
};

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
  const recoverOperatorMcpProposal = vi.fn();
  const [descriptor] = createIngestionSettingsProposalCopilotTools({
    proposalRepository: { createProposal },
    proposalRecovery: { recoverOperatorMcpProposal },
    proposalAdapters: [adapter],
    auditService: { record },
  });
  if (!descriptor) throw new Error("No ingestion settings proposal descriptor");
  return { descriptor, createProposal, recoverOperatorMcpProposal, record };
};

describe("propose_ingestion_settings", () => {
  it("validates the proposal input and output through the operator MCP catalog", async () => {
    const { adapter, settings } = adapterFor();
    const { descriptor, createProposal } = toolFor(adapter);
    const catalog = new OperatorMcpCatalogService([{
      ...descriptor,
      mcpDisposition: operatorMcpDispositions[descriptor.name],
    }]);

    await expect(catalog.invoke({
      name: "propose_ingestion_settings",
      arguments: { fixedWindowChunkSize: 1_500 },
      context: {
        ...context,
        surface: "mcp",
        copilotConversationId: undefined,
        operatorMcpInvocationId: "11111111-1111-4111-8111-111111111111",
      },
      scopes: new Set(["operator:propose"]),
      signal: AbortSignal.timeout(1_000),
    })).resolves.toMatchObject({
      proposalId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      targetType: "ingestion_settings",
    });
    expect(settings.prepareFieldProposal).toHaveBeenCalledWith("workspace-1", expect.objectContaining({ fixedWindowChunkSize: 1_500 }));
    expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({
      targetRef: { expectedFields: { fixedWindowChunkSize: 1_000 } },
    }));
  });

  it("expands a one-field change against the stored settings, because the write is a whole-object replace", async () => {
    const { adapter, settings } = adapterFor();
    const { descriptor, createProposal } = toolFor(adapter);

    await descriptor.createTool(context).invoke({
      fixedWindowChunkSize: 1_500,
      rationale: "Answers keep truncating mid-procedure.",
    }, {} as never);

    expect(settings.prepareFieldProposal).toHaveBeenCalledWith("workspace-1", expect.objectContaining({ fixedWindowChunkSize: 1_500 }));
    expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({
      targetType: "ingestion_settings",
      targetRef: { expectedFields: { fixedWindowChunkSize: 1_000 } },
      versionToken: expect.stringMatching(/^fields:/),
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

  it("reconstructs the exact normal result shape from a committed MCP proposal", async () => {
    const { adapter } = adapterFor();
    const { descriptor, recoverOperatorMcpProposal } = toolFor(adapter);
    const invocation = {
      id: "11111111-1111-4111-8111-111111111111",
      grantId: "22222222-2222-4222-8222-222222222222",
      operationId: "stable-operation",
      inputDigest: "keyed-input-digest",
    } as never;
    recoverOperatorMcpProposal.mockResolvedValueOnce({
      status: "recovered",
      proposal: {
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        targetType: "ingestion_settings",
        payload: {
          name: "Ingestion settings",
          chunkingStrategy: "fixed_window",
          fixedWindowChunkSize: 1_500,
          fixedWindowChunkOverlap: 100,
          structuredMinChunkSize: 200,
          structuredMaxChunkSize: 2_000,
          documentEnrichmentEnabled: false,
          manualDocumentEnrichmentOverride: "inherit",
          summary: "Change ingestion fixedWindowChunkSize to 1500.",
        },
      },
    });
    const mcpContext = {
      ...context,
      surface: "mcp" as const,
      copilotConversationId: undefined,
      operatorMcpInvocationId: "33333333-3333-4333-8333-333333333333",
    };
    const now = new Date("2026-09-04T00:03:00.000Z");
    const staleBefore = new Date("2026-09-04T00:01:00.000Z");

    await expect(descriptor.reconcileMcpInvocation!({ invocation, arguments: {}, context: mcpContext, now, staleBefore }))
      .resolves.toEqual({
        status: "recovered",
        output: {
          proposalId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          targetType: "ingestion_settings",
          targetLabel: "Ingestion settings",
          summary: "Change ingestion fixedWindowChunkSize to 1500.",
        },
      });
    expect(recoverOperatorMcpProposal).toHaveBeenCalledWith({
      invocationId: "11111111-1111-4111-8111-111111111111",
      grantId: "22222222-2222-4222-8222-222222222222",
      workspaceId: "workspace-1",
      operatorUserId: "operator-1",
      operationId: "stable-operation",
      descriptorName: "propose_ingestion_settings",
      inputDigest: "keyed-input-digest",
      staleBefore,
      now,
    });
  });
});

describe("ingestion settings proposal adapter", () => {
  it("writes the merged settings when the stored version still matches", async () => {
    const { adapter, settings } = adapterFor();

    const outcome = await adapter.applyIfVersionMatches("workspace-1", {}, {
      name: "Ingestion settings",
      chunkingStrategy: "fixed_window",
      fixedWindowChunkSize: 1_500,
      fixedWindowChunkOverlap: 100,
      structuredMinChunkSize: 200,
      structuredMaxChunkSize: 2_000,
    }, "2026-08-30T10:00:00.000Z");

    expect(settings.applyFieldProposal).toHaveBeenCalledWith("workspace-1", expect.objectContaining({ expectedUpdatedAt: new Date("2026-08-30T10:00:00.000Z") }));
    expect(outcome).toEqual({ outcome: "applied", appliedRef: { workspaceId: "workspace-1" } });
  });

  it("refuses a payload naming an embedding model outright, so applying can never start a re-embed", async () => {
    const { adapter, settings } = adapterFor();

    await expect(adapter.applyIfVersionMatches("workspace-1", {}, {
      name: "Ingestion settings",
      chunkingStrategy: "fixed_window",
      fixedWindowChunkSize: 1_500,
      fixedWindowChunkOverlap: 100,
      structuredMinChunkSize: 200,
      structuredMaxChunkSize: 2_000,
      embeddingModel: "text-embedding-3-large",
    }, "2026-08-30T10:00:00.000Z")).rejects.toThrow(/embeddingModel/);

    expect(settings.applyFieldProposal).not.toHaveBeenCalled();
  });

  // The version is the write's own predicate now, so staleness is what the settings service
  // reports back rather than something this adapter decides from a preceding read.
  it("reports a settings change as stale when the write refuses the drafted version", async () => {
    const settings = settingsPorts();
    settings.applyFieldProposal = vi.fn(async () => ({ status: "changed" as const, fields: ["fixedWindowChunkSize"] }));
    const { adapter } = adapterFor(settings);

    const outcome = await adapter.applyIfVersionMatches("workspace-1", {}, {
      name: "Ingestion settings",
      chunkingStrategy: "fixed_window",
      fixedWindowChunkSize: 1_500,
      fixedWindowChunkOverlap: 100,
      structuredMinChunkSize: 200,
      structuredMaxChunkSize: 2_000,
    }, "2026-08-01T10:00:00.000Z");

    expect(outcome).toEqual({ outcome: "stale", reason: "Field changed: fixedWindowChunkSize" });
  });

  it("previews only the fields the proposal changes against their stored values", async () => {
    const { adapter } = adapterFor();

    const preview = await adapter.preview("workspace-1", {}, {
      name: "Ingestion settings",
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
