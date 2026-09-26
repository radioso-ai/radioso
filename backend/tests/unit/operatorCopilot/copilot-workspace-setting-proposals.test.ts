import { describe, expect, it, vi } from "vitest";

import { presentProposalCard } from "../../../src/db/repositories/copilotRepository.js";
import { createWorkspaceSettingCopilotProposalAdapter } from "../../../src/modules/operatorCopilot/workspaceSettingProposalAdapter.js";
import { createWorkspaceSettingProposalCopilotTools } from "../../../src/modules/operatorCopilot/tools/workspaceSettingProposals.js";
import { OperatorMcpCatalogService } from "../../../src/modules/operatorCopilot/mcpCatalog.js";
import { badRequest } from "../../../src/shared/domain/errors.js";
import type { CopilotWorkspaceSettingPort } from "../../../src/modules/operatorCopilot/contracts/workspaceSettingAuthoring.js";

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
  assistantName: "Ada",
  greetingInstruction: "Greet warmly.",
  assistantDefaultLocale: null,
  proactiveGreetingEnabled: false,
  suggestedQuestionsEnabled: true,
  customInstruction: "",
  anonymousChatEnabled: false,
  websiteEmbedEnabled: true,
  websiteEmbedAllowedOrigins: ["https://example.com"],
  websiteEmbedLauncherLabel: "Ask us",
  websiteEmbedLauncherPosition: "bottom-right" as const,
  updatedAt: new Date("2026-09-01T10:00:00.000Z"),
  ...overrides,
});

/** The stored surface as a payload states it, so a test can name the one field it is changing. */
const storedPayload = (overrides: Record<string, unknown> = {}) => {
  const { updatedAt: _updatedAt, ...fields } = storedSettings();
  return { name: "Workspace settings" as const, ...fields, changesReach: false, ...overrides };
};

type SettingsPortMock = CopilotWorkspaceSettingPort & {
  getForWorkspace: ReturnType<typeof vi.fn>;
  applyFieldProposal: ReturnType<typeof vi.fn>;
};

const settingsPorts = (settings = storedSettings()): SettingsPortMock => {
  const getForWorkspace = vi.fn(async () => settings);
  const surface = () => {
    const { updatedAt: _updatedAt, ...current } = settings;
    return current;
  };
  return {
    getForWorkspace,
    prepareFieldProposal: vi.fn(async (_workspaceId, patch) => {
      const named = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
      if (Object.keys(named).length === 0) throw badRequest("Name at least one workspace setting to change");
      const current: Record<string, unknown> = surface();
      const normalized = { ...current, ...named } as Record<string, unknown>;
      if (Array.isArray(normalized.websiteEmbedAllowedOrigins)) {
        normalized.websiteEmbedAllowedOrigins = normalized.websiteEmbedAllowedOrigins.map((origin) => new URL(origin as string).origin);
      }
      if (normalized.websiteEmbedEnabled && Array.isArray(normalized.websiteEmbedAllowedOrigins) && normalized.websiteEmbedAllowedOrigins.length === 0) {
        throw badRequest(Object.hasOwn(named, "websiteEmbedAllowedOrigins") ? "Website embed needs an allowed origin" : "The workspace's stored website embed settings block any settings change until they are fixed: Website embed needs an allowed origin");
      }
      const changed = Object.keys(normalized).filter((key) => JSON.stringify(normalized[key]) !== JSON.stringify(current[key]));
      if (changed.length === 0) throw badRequest("The workspace settings already hold these values");
      return {
        normalizedPatch: normalized,
        expected: Object.fromEntries(changed.map((key) => [key, current[key]])),
        display: { current, proposed: normalized, changesReach: changed.some((key) => ["anonymousChatEnabled", "websiteEmbedEnabled", "websiteEmbedAllowedOrigins"].includes(key)) },
      };
    }),
    readFieldProposalVersion: vi.fn(async () => "fields:test"),
    readFieldProposalDisplay: vi.fn(async () => surface()),
    applyFieldProposal: vi.fn(async () => ({ status: "applied" as const })),
  };
};

const adapterFor = (settings = settingsPorts()) => ({
  adapter: createWorkspaceSettingCopilotProposalAdapter({ workspaceSetting: settings }),
  settings,
});

const toolFor = (adapter: ReturnType<typeof createWorkspaceSettingCopilotProposalAdapter>) => {
  const createProposal = vi.fn(async (input: Record<string, unknown>) => ({
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    ...input,
  }) as never);
  const record = vi.fn(async () => undefined);
  const [descriptor] = createWorkspaceSettingProposalCopilotTools({
    proposalRepository: { createProposal },
    proposalAdapters: [adapter],
    auditService: { record },
  });
  if (!descriptor) throw new Error("No workspace setting proposal descriptor");
  return { descriptor, createProposal, record };
};

describe("propose_workspace_setting", () => {
  it("validates field-scoped workspace proposals through the MCP catalog", async () => {
    const { adapter, settings } = adapterFor();
    const { descriptor, createProposal } = toolFor(adapter);
    const catalog = new OperatorMcpCatalogService([{
      ...descriptor,
      mcpDisposition: { status: "eligible", inputStrategy: "explicit", scope: "operator:propose", retry: { effect: "proposal", idempotent: true, operationIdentity: "client" } },
    }]);
    await expect(catalog.invoke({
      name: "propose_workspace_setting",
      arguments: { assistantName: "Ida" },
      context: { ...context, surface: "mcp", operatorMcpInvocationId: "11111111-1111-4111-8111-111111111111" },
      scopes: new Set(["operator:propose"]), signal: AbortSignal.timeout(1_000),
    })).resolves.toMatchObject({ targetType: "workspace_setting" });
    expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({ targetRef: { expectedFields: { assistantName: "Ada" } } }));
    settings.applyFieldProposal.mockResolvedValueOnce({ status: "changed", fields: ["assistantName"] });
    await expect(adapter.applyIfVersionMatches("workspace-1", { expectedFields: { assistantName: "Ada" } }, storedPayload({ assistantName: "Ida" }), "fields:test"))
      .resolves.toEqual({ outcome: "stale", reason: "Field changed: assistantName" });
  });

  it("expands a one-field change against the stored settings, because the write is a whole-object replace", async () => {
    const { adapter, settings } = adapterFor();
    const { descriptor, createProposal } = toolFor(adapter);

    await descriptor.createTool(context).invoke({
      websiteEmbedLauncherLabel: "Chat with us",
      rationale: "The launcher reads as support-only.",
    }, {} as never);

    expect(settings.prepareFieldProposal).toHaveBeenCalledWith("workspace-1", expect.objectContaining({ websiteEmbedLauncherLabel: "Chat with us" }));
    expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({
      targetType: "workspace_setting",
      targetRef: { expectedFields: { websiteEmbedLauncherLabel: "Ask us" } },
      versionToken: expect.stringMatching(/^fields:/),
      payload: expect.objectContaining({
        name: "Workspace settings",
        websiteEmbedLauncherLabel: "Chat with us",
        // Carried from the stored settings, not reset, because the apply replaces the whole surface.
        assistantName: "Ada",
        websiteEmbedAllowedOrigins: ["https://example.com"],
        anonymousChatEnabled: false,
      }),
    }));
  });

  it("marks a change to who can reach the agent, so the card states reach rather than leaving it in prose", async () => {
    const { adapter } = adapterFor();
    const { descriptor, createProposal } = toolFor(adapter);

    const output = await descriptor.createTool(context).invoke({
      anonymousChatEnabled: true,
      rationale: "The operator wants a public link.",
    }, {} as never) as { reach?: boolean };

    expect(output.reach).toBe(true);
    expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ changesReach: true, anonymousChatEnabled: true }),
    }));
  });

  it("adding an allowed origin is a reach change, because a new site can embed the agent", async () => {
    const { adapter } = adapterFor();
    const { descriptor } = toolFor(adapter);

    const output = await descriptor.createTool(context).invoke({
      websiteEmbedAllowedOrigins: ["https://example.com", "https://shop.example.com"],
    }, {} as never) as { reach?: boolean };

    expect(output.reach).toBe(true);
  });

  it("leaves a wording change unmarked, so the reach signal keeps meaning something", async () => {
    const { adapter } = adapterFor();
    const { descriptor, createProposal } = toolFor(adapter);

    const output = await descriptor.createTool(context).invoke({
      greetingInstruction: "Open with the shipping cut-off.",
    }, {} as never) as { reach?: boolean };

    expect(output.reach).toBeUndefined();
    expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ changesReach: false }),
    }));
  });

  it("refuses a change that names no setting", async () => {
    const { adapter } = adapterFor();
    const { descriptor } = toolFor(adapter);

    await expect(descriptor.createTool(context).invoke({ rationale: "Something is off." }, {} as never))
      .rejects.toThrow(/at least one/i);
  });

  it("decides reach on the origins the write will store, not the ones Ray typed", async () => {
    // The settings domain normalizes an origin down to its scheme and host. Diffing before that
    // would call this a reach change and then apply nothing.
    const { adapter } = adapterFor();
    const { descriptor } = toolFor(adapter);

    await expect(descriptor.createTool(context).invoke({
      websiteEmbedAllowedOrigins: ["https://example.com/widget"],
    }, {} as never)).rejects.toThrow(/already/i);
  });

  it("refuses at draft time a combination the settings domain would reject at apply", async () => {
    const { adapter } = adapterFor();
    const { descriptor } = toolFor(adapter);

    await expect(descriptor.createTool(context).invoke({
      websiteEmbedAllowedOrigins: [],
    }, {} as never)).rejects.toThrow(/allowed origin/i);
  });

  it("names the stored embed settings when they are what blocks a wording change", async () => {
    // An enabled embed with no origin is a state the read path tolerates and every settings write
    // refuses. A greeting proposal fails on it either way; an allowed-origin error with no
    // explanation is the version the operator cannot act on.
    const { adapter } = adapterFor(settingsPorts(storedSettings({
      websiteEmbedEnabled: true,
      websiteEmbedAllowedOrigins: [],
    })));
    const { descriptor } = toolFor(adapter);

    await expect(descriptor.createTool(context).invoke({
      greetingInstruction: "Open with the shipping cut-off.",
    }, {} as never)).rejects.toThrow(/stored website embed settings block any settings change/i);
  });

  it("refuses a change that restates what is already stored", async () => {
    const { adapter } = adapterFor();
    const { descriptor } = toolFor(adapter);

    await expect(descriptor.createTool(context).invoke({ assistantName: "Ada" }, {} as never))
      .rejects.toThrow(/already/i);
  });

  it("applies through the settings service with the version the card was drafted against", async () => {
    const settings = settingsPorts();
    const { adapter } = adapterFor(settings);

    const outcome = await adapter.applyIfVersionMatches("workspace-1", {}, storedPayload({ assistantName: "Ida" }), "2026-09-01T10:00:00.000Z");

    expect(outcome).toEqual({ outcome: "applied", appliedRef: { workspaceId: "workspace-1" } });
    expect(settings.applyFieldProposal).toHaveBeenCalledWith("workspace-1", expect.objectContaining({ expectedUpdatedAt: new Date("2026-09-01T10:00:00.000Z") }));
  });

  it("reports stale when the settings moved since the draft", async () => {
    const settings = settingsPorts();
    settings.applyFieldProposal.mockResolvedValueOnce({ status: "changed", fields: ["assistantName"] });
    const { adapter } = adapterFor(settings);

    const outcome = await adapter.applyIfVersionMatches("workspace-1", {}, storedPayload({ assistantName: "Ida" }), "2026-09-01T10:00:00.000Z");

    expect(outcome).toEqual({ outcome: "stale", reason: "Field changed: assistantName" });
  });

  it("reports a write that landed and then tripped over its own follow-up as applied, with what is unfinished", async () => {
    // The settings write commits before the public launch grants, the legacy mirror, and the embed
    // cache. Recording "failed" for settings that are already live invites applying them twice.
    const settings = settingsPorts();
    settings.applyFieldProposal.mockResolvedValueOnce({ status: "applied", reason: "The workspace settings now hold the proposed values, but the apply did not finish cleanly: grant sync failed" });
    const { adapter } = adapterFor(settings);

    const outcome = await adapter.applyIfVersionMatches("workspace-1", {}, storedPayload({ assistantName: "Ida" }), "2026-09-01T10:00:00.000Z");

    expect(outcome).toMatchObject({ outcome: "applied", appliedRef: { workspaceId: "workspace-1" } });
    expect((outcome as { reason?: string }).reason).toContain("now hold the proposed values");
    expect((outcome as { reason?: string }).reason).toContain("grant sync failed");
  });

  it("keeps a write that never landed a failure", async () => {
    const settings = settingsPorts();
    settings.applyFieldProposal.mockRejectedValueOnce(new Error("database unavailable"));
    const { adapter } = adapterFor(settings);

    const outcome = await adapter.applyIfVersionMatches("workspace-1", {}, storedPayload({ assistantName: "Ida" }), "2026-09-01T10:00:00.000Z");

    expect(outcome).toEqual({ outcome: "failed", reason: "database unavailable" });
  });

  it("previews the stored surface against the proposed one", async () => {
    const { adapter } = adapterFor();

    const preview = await adapter.preview("workspace-1", {}, storedPayload({ anonymousChatEnabled: true, changesReach: true }));

    expect(preview.targetLabel).toBe("Workspace settings");
    expect(preview.current).toEqual(expect.objectContaining({ anonymousChatEnabled: false }));
    expect(preview.proposed).toEqual(expect.objectContaining({ anonymousChatEnabled: true }));
    // The card's own presentation fields are not settings and must not read as a diff row.
    expect(preview.proposed).not.toHaveProperty("name");
    expect(preview.proposed).not.toHaveProperty("changesReach");
  });
});

describe("a reloaded workspace setting card", () => {
  it("states reach from the stored payload rather than re-deriving it from prose", () => {
    const card = presentProposalCard({
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      workspaceId: "workspace-1",
      operatorUserId: "operator-1",
      conversationId: "conversation-1",
      messageId: null,
      targetType: "workspace_setting",
      targetRef: {},
      payload: { name: "Workspace settings", summary: "Turn on the public chat link.", changesReach: true },
      versionToken: "2026-09-01T10:00:00.000Z",
      evidence: null,
      status: "pending",
      appliedRef: null,
      createdAt: new Date("2026-09-01T10:00:00.000Z"),
      updatedAt: new Date("2026-09-01T10:00:00.000Z"),
    } as never);

    expect(card.targetLabel).toBe("Workspace settings");
    expect(card.reach).toBe(true);
  });
});
