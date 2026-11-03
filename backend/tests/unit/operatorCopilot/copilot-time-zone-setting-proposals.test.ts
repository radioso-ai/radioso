import { describe, expect, it, vi } from "vitest";

import { createTimeZoneSettingCopilotProposalAdapter } from "../../../src/modules/operatorCopilot/timeZoneSettingProposalAdapter.js";
import { createTimeZoneSettingProposalCopilotTools } from "../../../src/modules/operatorCopilot/tools/timeZoneSettingProposals.js";
import { TimeZoneSettingsService, type TimeZoneSettings } from "../../../src/modules/settings/public.js";

const context = {
  workspaceId: "workspace-1",
  accountId: "account-1",
  operatorUserId: "operator-1",
  surface: "dashboard" as const,
  currentAuthorization: { hasAllPermissions: vi.fn(async () => true) },
  copilotConversationId: "conversation-1",
  pageContext: { view: "other" as const, agentId: null, conversationId: null, selection: null, entities: [] },
};

/** The real time zone settings behind the adapter, over one stored value. */
const timeZoneSettingsWith = (initial: TimeZoneSettings) => {
  let stored = initial;
  const service = new TimeZoneSettingsService({
    store: {
      read: async () => ({ accountId: "account-1", settings: stored }),
      write: async ({ settings, expected }) => {
        if (expected && expected.timeZone !== stored.timeZone) return { status: "changed" };
        const previous = stored;
        stored = settings;
        return { status: "written", accountId: "account-1", previous };
      },
    },
    audit: { record: vi.fn(async () => undefined) },
  });
  return { service, stored: () => stored, set: (next: TimeZoneSettings) => { stored = next; } };
};

const toolFor = (initial: TimeZoneSettings) => {
  const timeZone = timeZoneSettingsWith(initial);
  const adapter = createTimeZoneSettingCopilotProposalAdapter({ timeZoneSettings: timeZone.service });
  const createProposal = vi.fn(async (input: Record<string, unknown>) => ({ id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", ...input }) as never);
  const [descriptor] = createTimeZoneSettingProposalCopilotTools({
    proposalRepository: { createProposal },
    proposalAdapters: [adapter],
    auditService: { record: vi.fn(async () => undefined) },
    proposalRecovery: { recoverOperatorMcpProposal: vi.fn() },
  });
  if (!descriptor) throw new Error("No time zone setting proposal descriptor");
  return { descriptor, adapter, createProposal, timeZone };
};

describe("propose_time_zone_setting", () => {
  it("is a settings proposal that asks for the permission managing settings takes", () => {
    const { descriptor } = toolFor({ timeZone: null });

    expect(descriptor).toMatchObject({
      name: "propose_time_zone_setting",
      shape: "propose",
      contributingModule: "settings",
      requiredPermissions: ["workspace.settings.manage"],
    });
  });

  it("drafts a zone by its canonical name against the stored one, and writes nothing", async () => {
    const { descriptor, createProposal, timeZone } = toolFor({ timeZone: null });

    const output = await descriptor.createTool(context).invoke({ timeZone: "america/los_angeles" }, {} as never);

    expect(output).toMatchObject({ targetType: "time_zone_setting", targetLabel: "Time zone" });
    expect((output as { summary: string }).summary).toContain("America/Los_Angeles");
    expect(createProposal).toHaveBeenCalledWith(expect.objectContaining({
      targetType: "time_zone_setting",
      targetRef: { expectedFields: { timeZone: null } },
      payload: expect.objectContaining({ name: "Time zone", timeZone: "America/Los_Angeles" }),
      versionToken: expect.stringMatching(/^fields:/),
    }));
    expect(timeZone.stored()).toEqual({ timeZone: null });
  });

  it("refuses a zone the runtime does not know before drafting anything", async () => {
    const { descriptor, createProposal } = toolFor({ timeZone: null });

    await expect(descriptor.createTool(context).invoke({ timeZone: "Mars/Olympus_Mons" }, {} as never)).rejects.toThrow();
    expect(createProposal).not.toHaveBeenCalled();
  });

  it("applies the drafted zone while the stored one is unchanged, and goes stale once someone changed it", async () => {
    const { adapter, timeZone } = toolFor({ timeZone: null });
    const drafted = await adapter.validatePayload("workspace-1", {}, { timeZone: "Europe/Rome" });

    await expect(adapter.applyIfVersionMatches("workspace-1", drafted.targetRef, drafted.payload, drafted.versionToken))
      .resolves.toEqual({ outcome: "applied", appliedRef: { workspaceId: "workspace-1" } });
    expect(timeZone.stored()).toEqual({ timeZone: "Europe/Rome" });

    const redrafted = await adapter.validatePayload("workspace-1", {}, { timeZone: null });
    timeZone.set({ timeZone: "Asia/Tokyo" });
    await expect(adapter.applyIfVersionMatches("workspace-1", redrafted.targetRef, redrafted.payload, redrafted.versionToken))
      .resolves.toEqual({ outcome: "stale", reason: "Field changed: timeZone" });
    expect(timeZone.stored()).toEqual({ timeZone: "Asia/Tokyo" });
  });

  it("previews the stored zone beside the proposed one", async () => {
    const { adapter } = toolFor({ timeZone: "Europe/Rome" });
    const drafted = await adapter.validatePayload("workspace-1", {}, { timeZone: "Asia/Tokyo" });

    await expect(adapter.preview("workspace-1", drafted.targetRef, drafted.payload)).resolves.toEqual({
      targetLabel: "Time zone",
      current: { timeZone: "Europe/Rome" },
      proposed: { timeZone: "Asia/Tokyo" },
    });
  });
});
