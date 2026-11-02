import { describe, expect, it, vi } from "vitest";

import {
  TimeZoneSettingsService,
  type TimeZoneSettings,
  type TimeZoneSettingsStore,
} from "../../src/modules/settings/public.js";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";

const createStore = (initial: TimeZoneSettings | null): TimeZoneSettingsStore & { current: () => TimeZoneSettings | null } => {
  let stored = initial;
  return {
    current: () => stored,
    async read() {
      return stored ? { accountId: "acct-1", settings: { ...stored } } : null;
    },
    async write({ settings, expected }) {
      if (!stored) return { status: "not_found" };
      if (expected && expected.timeZone !== stored.timeZone) return { status: "changed" };
      const previous = stored;
      stored = { ...settings };
      return { status: "written", accountId: "acct-1", previous };
    },
  };
};

const createService = (initial: TimeZoneSettings | null = { timeZone: null }) => {
  const store = createStore(initial);
  const audit = { record: vi.fn(async () => undefined) };
  return { service: new TimeZoneSettingsService({ store, audit }), store, audit };
};

describe("TimeZoneSettingsService", () => {
  it("reads today in UTC when nothing was set", async () => {
    const { service } = createService();

    await expect(service.get(WORKSPACE)).resolves.toEqual({ timeZone: null });
  });

  it("stores a zone by its canonical name and records who changed it, from what to what", async () => {
    const { service, store, audit } = createService();

    await expect(service.update(WORKSPACE, { timeZone: " america/los_angeles " }, { userId: "user-1" }))
      .resolves.toEqual({ timeZone: "America/Los_Angeles" });

    expect(store.current()).toEqual({ timeZone: "America/Los_Angeles" });
    expect(audit.record).toHaveBeenCalledWith({
      accountId: "acct-1",
      workspaceId: WORKSPACE,
      eventType: "workspace.time_zone_settings.updated",
      eventStatus: "success",
      metadata: { actorUserId: "user-1", timeZone: { from: null, to: "America/Los_Angeles" } },
    });
  });

  it("stores the zone the operator chose, not ICU's older name for it", async () => {
    const { service, store, audit } = createService();

    await expect(service.update(WORKSPACE, { timeZone: "Asia/Kolkata" }, { userId: "user-1" }))
      .resolves.toEqual({ timeZone: "Asia/Kolkata" });

    expect(store.current()).toEqual({ timeZone: "Asia/Kolkata" });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { actorUserId: "user-1", timeZone: { from: null, to: "Asia/Kolkata" } },
    }));
  });

  it("clears the zone back to UTC", async () => {
    const { service, store } = createService({ timeZone: "Europe/Rome" });

    await service.update(WORKSPACE, { timeZone: null }, { userId: null });

    expect(store.current()).toEqual({ timeZone: null });
  });

  it("records nothing when the zone did not change", async () => {
    const { service, audit } = createService({ timeZone: "Europe/Rome" });

    await service.update(WORKSPACE, { timeZone: "Europe/Rome" }, { userId: "user-1" });

    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each(["Mars/Olympus_Mons", "+05:00", ""])("refuses %j, which is not an IANA zone", async (timeZone) => {
    const { service, store } = createService();

    await expect(service.update(WORKSPACE, { timeZone }, { userId: "user-1" })).rejects.toMatchObject({ statusCode: 400 });
    expect(store.current()).toEqual({ timeZone: null });
  });

  it("fails as not found for a workspace that does not exist", async () => {
    const { service } = createService(null);

    await expect(service.get(WORKSPACE)).rejects.toMatchObject({ statusCode: 404 });
  });

  describe("proposals", () => {
    it("prepares a change against the stored zone and applies it while that zone still holds", async () => {
      const { service, store, audit } = createService({ timeZone: "Europe/Rome" });

      const prepared = await service.prepareFieldProposal(WORKSPACE, { timeZone: "Asia/Tokyo" });
      expect(prepared).toEqual({
        normalized: { timeZone: "Asia/Tokyo" },
        expected: { timeZone: "Europe/Rome" },
        current: { timeZone: "Europe/Rome" },
      });

      await expect(service.applyFieldProposal(WORKSPACE, prepared)).resolves.toEqual({ status: "applied" });
      expect(store.current()).toEqual({ timeZone: "Asia/Tokyo" });
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
        eventType: "workspace.time_zone_settings.updated",
        metadata: { source: "copilot_proposal", timeZone: { from: "Europe/Rome", to: "Asia/Tokyo" } },
      }));
    });

    it("refuses a change that names nothing, restates the stored zone, or names an invalid one", async () => {
      const { service } = createService({ timeZone: "Europe/Rome" });

      await expect(service.prepareFieldProposal(WORKSPACE, {})).rejects.toMatchObject({ statusCode: 400 });
      await expect(service.prepareFieldProposal(WORKSPACE, { timeZone: "Europe/Rome" })).rejects.toMatchObject({ statusCode: 400 });
      await expect(service.prepareFieldProposal(WORKSPACE, { timeZone: "Not/AZone" })).rejects.toMatchObject({ statusCode: 400 });
    });

    it("leaves the zone alone when it changed after the proposal was drafted", async () => {
      const { service, store } = createService({ timeZone: "Europe/Rome" });
      const prepared = await service.prepareFieldProposal(WORKSPACE, { timeZone: "Asia/Tokyo" });
      await service.update(WORKSPACE, { timeZone: "America/New_York" }, { userId: "user-1" });

      await expect(service.applyFieldProposal(WORKSPACE, prepared)).resolves.toEqual({ status: "changed", fields: ["timeZone"] });
      expect(store.current()).toEqual({ timeZone: "America/New_York" });
    });

    it("versions the stored zone, so a version changes when the zone does", async () => {
      const { service } = createService({ timeZone: "Europe/Rome" });
      const before = await service.readFieldProposalVersion(WORKSPACE);

      await service.update(WORKSPACE, { timeZone: "Asia/Tokyo" }, { userId: "user-1" });

      expect(await service.readFieldProposalVersion(WORKSPACE)).not.toBe(before);
      await expect(service.readFieldProposalDisplay(WORKSPACE)).resolves.toEqual({ timeZone: "Asia/Tokyo" });
    });
  });
});
