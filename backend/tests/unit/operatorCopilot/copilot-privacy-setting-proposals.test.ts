import { describe, expect, it, vi } from "vitest";

import { createPrivacySettingCopilotProposalAdapter } from "../../../src/modules/operatorCopilot/privacySettingProposalAdapter.js";
import { createPrivacySettingProposalCopilotTools } from "../../../src/modules/operatorCopilot/tools/privacySettingProposals.js";
import { PrivacySettingsService, type PrivacySettings } from "../../../src/modules/privacy/public.js";

const context = {
  workspaceId: "workspace-1",
  accountId: "account-1",
  operatorUserId: "operator-1",
  surface: "dashboard" as const,
  currentAuthorization: { hasAllPermissions: vi.fn(async () => true) },
  copilotConversationId: "conversation-1",
  pageContext: { view: "other" as const, agentId: null, conversationId: null, selection: null, entities: [] },
};

/** The real privacy settings behind the adapter, over one stored value. */
const privacySettingsWith = (initial: PrivacySettings) => {
  let stored = initial;
  const audit = { record: vi.fn(async () => undefined) };
  const service = new PrivacySettingsService({
    store: {
      read: async () => ({ accountId: "account-1", settings: stored }),
      write: async ({ settings, expected }) => {
        if (expected && expected.conversationRetentionDays !== stored.conversationRetentionDays) return { status: "changed" };
        const previous = stored;
        stored = settings;
        return { status: "written", accountId: "account-1", previous };
      },
    },
    audit,
  });
  return { service, audit, stored: () => stored, set: (next: PrivacySettings) => { stored = next; } };
};

const toolFor = (initial: PrivacySettings) => {
  const privacy = privacySettingsWith(initial);
  const adapter = createPrivacySettingCopilotProposalAdapter({ privacySettings: privacy.service });
  const createProposal = vi.fn(async (input: Record<string, unknown>) => ({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", ...input }) as never);
  const [descriptor] = createPrivacySettingProposalCopilotTools({
    proposalRepository: { createProposal },
    proposalAdapters: [adapter],
    auditService: { record: vi.fn(async () => undefined) },
    proposalRecovery: { recoverOperatorMcpProposal: vi.fn() },
  });
  if (!descriptor) throw new Error("No privacy setting proposal descriptor");
  return { descriptor, adapter, createProposal, privacy };
};

describe("propose_privacy_setting", () => {
  it("asks for the permission deleting a conversation takes, on top of managing settings", () => {
    const { descriptor } = toolFor({ conversationRetentionDays: null });

    expect(descriptor).toMatchObject({
      name: "propose_privacy_setting",
      shape: "propose",
      contributingModule: "privacy",
      requiredPermissions: ["workspace.settings.manage", "workspace.history.delete"],
    });
  });

  it("drafts a window against the stored one, and says the sweep then erases what is already past it", async () => {
    const { descriptor, createProposal, privacy } = toolFor({ conversationRetentionDays: null });

    const output = await descriptor.createTool(context).invoke({ conversationRetentionDays: 365 }, {} as never);

    expect(output).toMatchObject({ targetType: "privacy_setting", targetLabel: "Privacy settings" });
    expect((output as { summary: string }).summary).toMatch(/365 days/);
    expect((output as { summary: string }).summary).toMatch(/no undo/);
    expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({
      targetType: "privacy_setting",
      targetRef: { expectedFields: { conversationRetentionDays: null } },
      payload: expect.objectContaining({ name: "Privacy settings", conversationRetentionDays: 365, erasesSooner: true }),
      versionToken: expect.stringMatching(/^fields:/),
    }));
    // Drafting writes nothing; only the operator's Apply does.
    expect(privacy.stored()).toEqual({ conversationRetentionDays: null });
  });

  it("states no earlier erasure for a longer window or for keeping conversations until deleted", async () => {
    const { descriptor, createProposal } = toolFor({ conversationRetentionDays: 90 });

    await descriptor.createTool(context).invoke({ conversationRetentionDays: 365 }, {} as never);
    await descriptor.createTool(context).invoke({ conversationRetentionDays: null }, {} as never);

    expect(createProposal.mock.calls.map(([input]) => (input.payload as { erasesSooner: boolean }).erasesSooner)).toEqual([false, false]);
  });

  it("refuses a window outside 7 to 3650 days before drafting anything", async () => {
    const { descriptor, createProposal } = toolFor({ conversationRetentionDays: null });

    await expect(descriptor.createTool(context).invoke({ conversationRetentionDays: 3 }, {} as never)).rejects.toThrow();
    expect(createProposal).not.toHaveBeenCalled();
  });

  it("applies the drafted window while the stored one is unchanged, and goes stale once someone changed it", async () => {
    const { adapter, privacy } = toolFor({ conversationRetentionDays: null });
    const drafted = await adapter.validatePayload("workspace-1", {}, { conversationRetentionDays: 180 });

    await expect(adapter.applyIfVersionMatches("workspace-1", drafted.targetRef, drafted.payload, drafted.versionToken))
      .resolves.toEqual({ outcome: "applied", appliedRef: { workspaceId: "workspace-1" } });
    expect(privacy.stored()).toEqual({ conversationRetentionDays: 180 });

    const redrafted = await adapter.validatePayload("workspace-1", {}, { conversationRetentionDays: 30 });
    privacy.set({ conversationRetentionDays: 60 });
    await expect(adapter.applyIfVersionMatches("workspace-1", redrafted.targetRef, redrafted.payload, redrafted.versionToken))
      .resolves.toEqual({ outcome: "stale", reason: "Field changed: conversationRetentionDays" });
    expect(privacy.stored()).toEqual({ conversationRetentionDays: 60 });
  });

  it("previews the stored window beside the proposed one", async () => {
    const { adapter } = toolFor({ conversationRetentionDays: 90 });
    const drafted = await adapter.validatePayload("workspace-1", {}, { conversationRetentionDays: 30 });

    await expect(adapter.preview("workspace-1", drafted.targetRef, drafted.payload)).resolves.toEqual({
      targetLabel: "Privacy settings",
      current: { conversationRetentionDays: 90 },
      proposed: { conversationRetentionDays: 30 },
    });
  });
});
