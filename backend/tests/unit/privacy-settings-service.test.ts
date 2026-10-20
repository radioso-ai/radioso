import { describe, expect, it, vi } from "vitest";

import { PrivacySettingsService, type PrivacySettings, type PrivacySettingsStore } from "../../src/modules/privacy/public.js";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";

const createStore = (initial: PrivacySettings | null): PrivacySettingsStore & { current: () => PrivacySettings | null } => {
  let stored = initial;
  return {
    current: () => stored,
    async read() {
      return stored ? { accountId: "acct-1", settings: { ...stored } } : null;
    },
    async write({ settings, expected }) {
      if (!stored) return { status: "not_found" };
      if (expected && expected.conversationRetentionDays !== stored.conversationRetentionDays) return { status: "changed" };
      const previous = stored;
      stored = { ...settings };
      return { status: "written", accountId: "acct-1", previous };
    },
  };
};

const createService = (initial: PrivacySettings | null = { conversationRetentionDays: null }) => {
  const store = createStore(initial);
  const audit = { record: vi.fn(async () => undefined) };
  return { service: new PrivacySettingsService({ store, audit }), store, audit };
};

describe("PrivacySettingsService", () => {
  it("keeps conversations until they are deleted when nothing was set", async () => {
    const { service } = createService();

    await expect(service.get(WORKSPACE)).resolves.toEqual({ conversationRetentionDays: null });
  });

  it("sets a window and records who changed it, from what to what", async () => {
    const { service, store, audit } = createService();

    await service.update(WORKSPACE, { conversationRetentionDays: 365 }, { userId: "user-1" });

    expect(store.current()).toEqual({ conversationRetentionDays: 365 });
    expect(audit.record).toHaveBeenCalledWith({
      accountId: "acct-1",
      workspaceId: WORKSPACE,
      eventType: "workspace.privacy_settings.updated",
      eventStatus: "success",
      metadata: { actorUserId: "user-1", conversationRetentionDays: { from: null, to: 365 } },
    });
  });

  it("records nothing when the window did not change", async () => {
    const { service, audit } = createService({ conversationRetentionDays: 90 });

    await service.update(WORKSPACE, { conversationRetentionDays: 90 }, { userId: "user-1" });

    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each([6, 3651, 30.5])("refuses %s days, outside the whole days from 7 to 3650", async (days) => {
    const { service, store } = createService();

    await expect(service.update(WORKSPACE, { conversationRetentionDays: days }, { userId: null })).rejects.toMatchObject({ statusCode: 400 });
    expect(store.current()).toEqual({ conversationRetentionDays: null });
  });

  it.each([7, 3650, null])("accepts %s", async (days) => {
    const { service, store } = createService({ conversationRetentionDays: 30 });

    await service.update(WORKSPACE, { conversationRetentionDays: days }, { userId: null });

    expect(store.current()).toEqual({ conversationRetentionDays: days });
  });

  it("answers not found for a workspace that is gone", async () => {
    const { service } = createService(null);

    await expect(service.get(WORKSPACE)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.update(WORKSPACE, { conversationRetentionDays: 30 }, { userId: null })).rejects.toMatchObject({ statusCode: 404 });
  });

  describe("proposals", () => {
    it("drafts a change against the stored window and applies it while the window still holds that value", async () => {
      const { service, store, audit } = createService({ conversationRetentionDays: null });

      const prepared = await service.prepareFieldProposal(WORKSPACE, { conversationRetentionDays: 180 });
      const outcome = await service.applyFieldProposal(WORKSPACE, prepared);

      expect(prepared).toEqual({
        normalized: { conversationRetentionDays: 180 },
        expected: { conversationRetentionDays: null },
        current: { conversationRetentionDays: null },
      });
      expect(outcome).toEqual({ status: "applied" });
      expect(store.current()).toEqual({ conversationRetentionDays: 180 });
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
        metadata: { source: "copilot_proposal", conversationRetentionDays: { from: null, to: 180 } },
      }));
    });

    it("reports the field as changed, and writes nothing, when someone changed the window after the draft", async () => {
      const { service, store } = createService({ conversationRetentionDays: null });
      const prepared = await service.prepareFieldProposal(WORKSPACE, { conversationRetentionDays: 180 });
      await service.update(WORKSPACE, { conversationRetentionDays: 30 }, { userId: "user-2" });

      await expect(service.applyFieldProposal(WORKSPACE, prepared)).resolves.toEqual({ status: "changed", fields: ["conversationRetentionDays"] });
      expect(store.current()).toEqual({ conversationRetentionDays: 30 });
    });

    it("refuses a draft that names nothing, restates the stored window, or leaves the range", async () => {
      const { service } = createService({ conversationRetentionDays: 90 });

      await expect(service.prepareFieldProposal(WORKSPACE, {})).rejects.toMatchObject({ statusCode: 400 });
      await expect(service.prepareFieldProposal(WORKSPACE, { conversationRetentionDays: 90 })).rejects.toMatchObject({ statusCode: 400 });
      await expect(service.prepareFieldProposal(WORKSPACE, { conversationRetentionDays: 1 })).rejects.toMatchObject({ statusCode: 400 });
    });

    it("versions a draft by the stored window, so a changed window changes the version", async () => {
      const { service } = createService({ conversationRetentionDays: 90 });

      const before = await service.readFieldProposalVersion(WORKSPACE);
      await service.update(WORKSPACE, { conversationRetentionDays: 30 }, { userId: null });

      expect(await service.readFieldProposalVersion(WORKSPACE)).not.toBe(before);
    });
  });
});
