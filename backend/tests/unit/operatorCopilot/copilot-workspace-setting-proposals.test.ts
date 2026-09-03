import { describe, expect, it, vi } from "vitest";

import { presentProposalCard } from "../../../src/db/repositories/copilotRepository.js";
import { createWorkspaceSettingCopilotProposalAdapter } from "../../../src/modules/operatorCopilot/workspaceSettingProposalAdapter.js";
import { createWorkspaceSettingProposalCopilotTools } from "../../../src/modules/operatorCopilot/tools/workspaceSettingProposals.js";
import { conflict } from "../../../src/shared/domain/errors.js";

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

const settingsPorts = (settings = storedSettings()) => ({
  getForWorkspace: vi.fn(async () => settings),
  updateForWorkspace: vi.fn(async () => settings),
});

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
  it("expands a one-field change against the stored settings, because the write is a whole-object replace", async () => {
    const { adapter, settings } = adapterFor();
    const { descriptor, createProposal } = toolFor(adapter);

    await descriptor.createTool(context).invoke({
      websiteEmbedLauncherLabel: "Chat with us",
      rationale: "The launcher reads as support-only.",
    }, {} as never);

    expect(settings.getForWorkspace).toHaveBeenCalledWith("workspace-1");
    expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({
      targetType: "workspace_setting",
      targetRef: {},
      versionToken: "2026-09-01T10:00:00.000Z",
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
    expect(settings.updateForWorkspace).toHaveBeenCalledWith(
      "workspace-1",
      expect.objectContaining({ assistantName: "Ida" }),
      { expectedUpdatedAt: new Date("2026-09-01T10:00:00.000Z") },
    );
  });

  it("reports stale when the settings moved since the draft", async () => {
    const settings = settingsPorts();
    settings.updateForWorkspace.mockRejectedValueOnce(conflict("Settings changed"));
    const { adapter } = adapterFor(settings);

    const outcome = await adapter.applyIfVersionMatches("workspace-1", {}, storedPayload({ assistantName: "Ida" }), "2026-09-01T10:00:00.000Z");

    expect(outcome).toEqual({ outcome: "stale" });
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
    });

    expect(card.targetLabel).toBe("Workspace settings");
    expect(card.reach).toBe(true);
  });
});
