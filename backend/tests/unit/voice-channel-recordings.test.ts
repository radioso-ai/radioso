import { describe, expect, it, vi } from "vitest";

import {
  VoiceRecordingRequestError,
  type VoiceRecordingRef,
  type VoiceReportableSession,
  type VoiceRecordingSource,
  type VoiceRecordingStore,
  type VoiceRecordingStream,
  type VoiceRecordingToErase,
  type VoiceVendorCredentialPresence,
  type VoiceVendorCredentialReading,
} from "../../src/modules/voiceChannel/domain.js";
import { VoiceRecordingErasureService, VoiceRecordingService, type VoiceRecordingAudit } from "../../src/modules/voiceChannel/public.js";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const conversationId = "66666666-6666-4666-8666-666666666666";
const actorUserId = "77777777-7777-4777-8777-777777777777";
const apiKey = "xi-secret-0123456789";
const vendorConversationId = "conv_01jx8k2m3n4p5q6r7s8t9v0w1x";
const recordingRef: VoiceRecordingRef = { conversationId, vendor: "elevenlabs", region: "eu", vendorConversationId };

const erasable = (recording: VoiceRecordingRef): VoiceRecordingToErase => ({ ...recording, workspaceId });

const audioStream = (): VoiceRecordingStream => ({
  status: 200,
  body: new ReadableStream({ start: (controller) => controller.close() }),
  contentType: "audio/mpeg",
  contentLength: 0,
});

const harness = (overrides: {
  recording?: VoiceRecordingRef | null | Error;
  recordings?: VoiceRecordingToErase[] | Error;
  recorded?: boolean;
  reportable?: VoiceReportableSession | null;
  describeConversation?: VoiceRecordingSource["describeConversation"];
  credential?: VoiceVendorCredentialReading | Error;
  stored?: VoiceVendorCredentialPresence | Error;
  fetchRecording?: VoiceRecordingSource["fetchRecording"];
  deleteRecording?: VoiceRecordingSource["deleteRecording"];
  played?: VoiceRecordingAudit["played"];
} = {}) => {
  const logger = { warn: vi.fn(), info: vi.fn() };
  const metrics = { incrementCounter: vi.fn() };
  const store = {
    findReportableSession: vi.fn<VoiceRecordingStore["findReportableSession"]>(async () =>
      overrides.reportable === undefined ? { vendor: "elevenlabs", vendorAgent: { agentId: "agent_42", region: "eu" } } : overrides.reportable),
    recordVendorConversation: vi.fn<VoiceRecordingStore["recordVendorConversation"]>(async () => overrides.recorded ?? true),
    findRecording: vi.fn<VoiceRecordingStore["findRecording"]>(async () => {
      const recording = overrides.recording === undefined ? recordingRef : overrides.recording;
      if (recording instanceof Error) throw recording;
      return recording;
    }),
    listRecordings: vi.fn<VoiceRecordingStore["listRecordings"]>(async () => {
      const recordings = overrides.recordings ?? [erasable(recordingRef)];
      if (recordings instanceof Error) throw recordings;
      return recordings;
    }),
  };
  const credentials = {
    read: vi.fn(async (): Promise<VoiceVendorCredentialReading> => {
      const credential = overrides.credential ?? { kind: "present", credential: { apiKey } };
      if (credential instanceof Error) throw credential;
      return credential;
    }),
    presence: vi.fn(async (): Promise<VoiceVendorCredentialPresence> => {
      const stored = overrides.stored ?? "stored";
      if (stored instanceof Error) throw stored;
      return stored;
    }),
  };
  const source = {
    describeConversation: vi.fn<VoiceRecordingSource["describeConversation"]>(overrides.describeConversation ?? (async () => ({ vendorAgentId: "agent_42" }))),
    fetchRecording: vi.fn<VoiceRecordingSource["fetchRecording"]>(overrides.fetchRecording ?? (async () => audioStream())),
    deleteRecording: vi.fn<VoiceRecordingSource["deleteRecording"]>(overrides.deleteRecording ?? (async () => "deleted")),
  };
  const audit = {
    played: vi.fn<VoiceRecordingAudit["played"]>(overrides.played ?? (async () => undefined)),
    deleted: vi.fn<VoiceRecordingAudit["deleted"]>(async () => undefined),
  };
  const dependencies = { recordings: store, credentials, sources: { elevenlabs: source }, audit, metrics, logger };
  return {
    service: new VoiceRecordingService(dependencies),
    eraser: new VoiceRecordingErasureService(dependencies),
    store,
    credentials,
    source,
    audit,
    metrics,
    logger,
  };
};

const counted = (metrics: { incrementCounter: ReturnType<typeof vi.fn> }, name: string) =>
  metrics.incrementCounter.mock.calls
    .filter(([metric]) => metric === name)
    .map(([, options]) => (options as { labels: Record<string, string> }).labels);

describe("voice vendor conversation report", () => {
  const report = { workspaceId, agentId, sessionKey: "33333333-3333-4333-8333-333333333333", publicSessionId: "pub-1", vendorConversationId };

  const { vendorConversationId: _reported, ...sessionOfReport } = report;
  void _reported;

  it("stores the vendor's conversation id once the vendor confirms it is a call on the session's vendor agent", async () => {
    const { service, store, source, metrics } = harness();

    await expect(service.report(report)).resolves.toBe("recorded");

    expect(store.findReportableSession).toHaveBeenCalledWith(sessionOfReport);
    expect(source.describeConversation).toHaveBeenCalledWith({ vendorConversationId, region: "eu", credential: { apiKey } });
    expect(store.recordVendorConversation).toHaveBeenCalledWith(report);
    expect(counted(metrics, "voice_vendor_conversation_report_total")).toEqual([{ vendor: "elevenlabs", outcome: "recorded" }]);
  });

  it("refuses a report no started session waits for, without asking the vendor, and logs ids only", async () => {
    const { service, source, store, logger } = harness({ reportable: null });

    await expect(service.report(report)).resolves.toBe("rejected");
    expect(source.describeConversation).not.toHaveBeenCalled();
    expect(store.recordVendorConversation).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith({ workspaceId, agentId, vendor: "none", outcome: "no_session" }, "Voice vendor conversation report was refused");
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(vendorConversationId);
  });

  it("refuses a call on another vendor agent for good, and fails one the vendor cannot show yet so the page reports again", async () => {
    const otherAgent = harness({ describeConversation: async () => ({ vendorAgentId: "agent_someone_else" }) });
    await expect(otherAgent.service.report(report)).resolves.toBe("rejected");
    expect(otherAgent.store.recordVendorConversation).not.toHaveBeenCalled();
    expect(counted(otherAgent.metrics, "voice_vendor_conversation_report_total")).toEqual([{ vendor: "elevenlabs", outcome: "vendor_agent_mismatch" }]);
    expect(JSON.stringify(otherAgent.logger.warn.mock.calls)).not.toContain("agent_someone_else");

    // Right after the call connects the vendor may not show the conversation yet: not final.
    const notYet = harness({ describeConversation: async () => {
      throw new VoiceRecordingRequestError("not_found", 404);
    } });
    await expect(notYet.service.report(report)).resolves.toBe("failed");
    expect(notYet.store.recordVendorConversation).not.toHaveBeenCalled();
    expect(counted(notYet.metrics, "voice_vendor_conversation_report_total")).toEqual([{ vendor: "elevenlabs", outcome: "vendor_not_found" }]);
  });

  it("refuses an id another session already holds", async () => {
    const { service, metrics } = harness({ recorded: false });

    await expect(service.report(report)).resolves.toBe("rejected");
    expect(counted(metrics, "voice_vendor_conversation_report_total")).toEqual([{ vendor: "elevenlabs", outcome: "already_reported" }]);
  });

  it.each([
    ["the vendor refuses the check", { describeConversation: async () => {
      throw new VoiceRecordingRequestError("rejected", 401);
    } }, "vendor_failed"],
    ["the workspace holds no key", { credential: { kind: "missing" } as const }, "credential_missing"],
    ["the credential store cannot be read", { credential: new Error("connection refused") }, "credential_read_failed"],
  ])("fails a report that cannot be checked when %s, storing nothing", async (_case, overrides, outcome) => {
    const { service, store, metrics, logger } = harness(overrides);

    await expect(service.report(report)).resolves.toBe("failed");
    expect(store.recordVendorConversation).not.toHaveBeenCalled();
    expect(counted(metrics, "voice_vendor_conversation_report_total")).toEqual([{ vendor: "elevenlabs", outcome }]);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(apiKey);
  });
});

describe("voice recording availability", () => {
  const call = { workspaceId, conversationId, sourceChannel: "voice" };

  it("is available when the conversation's session has a vendor conversation and the workspace holds a readable key", async () => {
    const { service, credentials, source } = harness();

    await expect(service.availability(call)).resolves.toBe(true);
    expect(credentials.presence).toHaveBeenCalledWith({ workspaceId, vendor: "elevenlabs" });
    expect(credentials.read).not.toHaveBeenCalled();
    expect(source.fetchRecording).not.toHaveBeenCalled();
  });

  it.each([
    ["the conversation has no reported vendor conversation", { recording: null }],
    ["the workspace holds no key for the vendor", { stored: "missing" as const }],
    ["the backend cannot decrypt the key", { stored: "unreadable" as const }],
  ])("is not available when %s", async (_case, overrides) => {
    await expect(harness(overrides).service.availability(call)).resolves.toBe(false);
  });

  it("says nothing of a recording for a conversation that is not a call, and reads nothing for it", async () => {
    const { service, store } = harness();

    await expect(service.availability({ ...call, sourceChannel: "website_embed" })).resolves.toBeNull();
    await expect(service.availability({ ...call, sourceChannel: null })).resolves.toBeNull();
    expect(store.findRecording).not.toHaveBeenCalled();
  });

  it("says nothing, and logs ids only, when the stores cannot be read", async () => {
    const { service, logger } = harness({ stored: new Error("connection refused") });

    await expect(service.availability(call)).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith({ workspaceId, conversationId, errorClass: "Error" }, "Voice recording availability could not be read");
  });
});

describe("voice recording playback", () => {
  const play = { workspaceId, conversationId, actorUserId };

  it("opens the recording on the vendor with the workspace's key in the account's region, and audits the play", async () => {
    const { service, source, audit, metrics } = harness();

    const result = await service.play({ ...play, range: "bytes=0-" });

    expect(result).toMatchObject({ kind: "recording", recording: { status: 200, contentType: "audio/mpeg" } });
    expect(source.fetchRecording).toHaveBeenCalledWith(expect.objectContaining({
      vendorConversationId,
      region: "eu",
      credential: { apiKey },
      range: "bytes=0-",
    }));
    // The vendor answered with the whole recording, so the play is whole, whatever the player asked.
    expect(audit.played).toHaveBeenCalledWith({ workspaceId, conversationId, actorUserId, vendor: "elevenlabs", partial: false });
    expect(counted(metrics, "voice_recording_fetch_total")).toEqual([{ vendor: "elevenlabs", outcome: "served" }]);
  });

  it.each([
    ["a part from the start", "bytes 0-1023/4096", false],
    ["a part further in, as a seek asks for", "bytes 2048-4095/4096", true],
  ])("audits %s as partial: %s", async (_case, contentRange, partial) => {
    const { service, audit } = harness({ fetchRecording: async () => ({ ...audioStream(), status: 206, contentRange }) });

    await service.play({ ...play, range: "bytes=0-" });

    expect(audit.played).toHaveBeenCalledWith(expect.objectContaining({ partial }));
  });

  it("answers a range past the recording's end with the vendor's length, auditing nothing", async () => {
    const { service, audit, metrics, logger } = harness({ fetchRecording: async () => {
      throw new VoiceRecordingRequestError("range_not_satisfiable", 416, "bytes */4096");
    } });

    await expect(service.play({ ...play, range: "bytes=9000-" })).resolves.toEqual({ kind: "range_not_satisfiable", contentRange: "bytes */4096" });
    expect(audit.played).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(counted(metrics, "voice_recording_fetch_total")).toEqual([{ vendor: "elevenlabs", outcome: "range_not_satisfiable" }]);
  });

  it("lets a listener who went away go quietly: no warn, no failure counted, no audit", async () => {
    const listener = new AbortController();
    const { service, audit, metrics, logger } = harness({ fetchRecording: async () => {
      listener.abort();
      throw new VoiceRecordingRequestError("timeout");
    } });

    await expect(service.play({ ...play, signal: listener.signal })).resolves.toEqual({ kind: "abandoned" });
    expect(audit.played).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(counted(metrics, "voice_recording_fetch_total")).toEqual([]);
  });

  it("finds nothing for a conversation without a recording, and asks the vendor nothing", async () => {
    const { service, source, audit, metrics } = harness({ recording: null });

    await expect(service.play(play)).resolves.toEqual({ kind: "not_found" });
    expect(source.fetchRecording).not.toHaveBeenCalled();
    expect(audit.played).not.toHaveBeenCalled();
    expect(counted(metrics, "voice_recording_fetch_total")).toEqual([{ vendor: "none", outcome: "no_recording" }]);
  });

  it("finds nothing when the vendor holds no audio under the id", async () => {
    const { service, audit, metrics, logger } = harness({
      fetchRecording: async () => {
        throw new VoiceRecordingRequestError("not_found", 404);
      },
    });

    await expect(service.play(play)).resolves.toEqual({ kind: "not_found" });
    expect(audit.played).not.toHaveBeenCalled();
    expect(counted(metrics, "voice_recording_fetch_total")).toEqual([{ vendor: "elevenlabs", outcome: "vendor_not_found" }]);
    expect(logger.warn).toHaveBeenCalledWith(
      { workspaceId, conversationId, vendor: "elevenlabs", outcome: "vendor_not_found", reason: "not_found", vendorStatus: 404 },
      "Voice recording could not be read",
    );
  });

  it.each([
    ["the vendor refuses", { fetchRecording: async () => {
      throw new VoiceRecordingRequestError("rejected", 401);
    } }, "vendor_failed"],
    ["the workspace holds no key", { credential: { kind: "missing" } as const }, "credential_missing"],
    ["the key cannot be decrypted", { credential: { kind: "unreadable" } as const }, "credential_unreadable"],
    ["the credential store cannot be read", { credential: new Error("connection refused") }, "credential_read_failed"],
    ["the session store cannot be read", { recording: new Error("connection refused") }, "store_failed"],
  ])("is unavailable when %s, and logs which with ids only", async (_case, overrides, outcome) => {
    const { service, audit, metrics, logger } = harness(overrides);

    await expect(service.play(play)).resolves.toEqual({ kind: "unavailable" });
    expect(audit.played).not.toHaveBeenCalled();
    expect(counted(metrics, "voice_recording_fetch_total")).toEqual([{ vendor: outcome === "store_failed" ? "none" : "elevenlabs", outcome }]);
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).toContain(outcome);
    expect(logged).not.toContain(apiKey);
    expect(logged).not.toContain(vendorConversationId);
  });

  it("refuses to play a recording whose play cannot be audited, and lets go of the vendor's body", async () => {
    const cancel = vi.fn();
    const { service, metrics } = harness({
      fetchRecording: async () => ({ ...audioStream(), body: new ReadableStream({ cancel }) }),
      played: async () => {
        throw new Error("audit store down");
      },
    });

    await expect(service.play(play)).resolves.toEqual({ kind: "unavailable" });
    expect(cancel).toHaveBeenCalled();
    expect(counted(metrics, "voice_recording_fetch_total")).toEqual([{ vendor: "elevenlabs", outcome: "audit_failed" }]);
  });
});

describe("voice recording erasure", () => {
  const accountId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const otherWorkspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const second: VoiceRecordingRef = { ...recordingRef, conversationId: "88888888-8888-4888-8888-888888888888", vendorConversationId: "conv_second" };
  const workspaceDeletion = { account: { id: accountId, deleted: false }, scopes: [{ kind: "workspace" as const, workspaceId }] };

  it("reads the recordings and the key while they exist, and deletes each at the vendor once erase runs, auditing each", async () => {
    const { eraser, store, credentials, source, audit, metrics } = harness({ recordings: [erasable(recordingRef), erasable(second)] });

    const prepared = await eraser.prepare(workspaceDeletion);

    expect(store.listRecordings).toHaveBeenCalledWith({ kind: "workspace", workspaceId });
    expect(credentials.read).toHaveBeenCalledWith({ workspaceId, vendor: "elevenlabs" });
    expect(source.deleteRecording).not.toHaveBeenCalled();

    await prepared.erase();

    expect(source.deleteRecording.mock.calls.map(([input]) => input)).toEqual([
      { vendorConversationId, region: "eu", credential: { apiKey } },
      { vendorConversationId: "conv_second", region: "eu", credential: { apiKey } },
    ]);
    expect(audit.deleted.mock.calls.map(([event]) => event)).toEqual([
      { account: { id: accountId, deleted: false }, workspaceId, workspaceDeleted: true, conversationId, vendor: "elevenlabs", outcome: "deleted" },
      { account: { id: accountId, deleted: false }, workspaceId, workspaceDeleted: true, conversationId: second.conversationId, vendor: "elevenlabs", outcome: "deleted" },
    ]);
    expect(counted(metrics, "voice_recording_delete_total")).toEqual([
      { vendor: "elevenlabs", outcome: "deleted" },
      { vendor: "elevenlabs", outcome: "deleted" },
    ]);
  });

  it("audits a recording the vendor no longer held as already absent", async () => {
    const { eraser, audit, metrics } = harness({ deleteRecording: async () => "already_absent" });

    await (await eraser.prepare(workspaceDeletion)).erase();

    expect(audit.deleted.mock.calls.map(([event]) => event.outcome)).toEqual(["already_absent"]);
    expect(counted(metrics, "voice_recording_delete_total")).toEqual([{ vendor: "elevenlabs", outcome: "already_absent" }]);
  });

  it("keeps going past a recording the vendor would not delete, logs where it is, and never rejects", async () => {
    const { eraser, audit, logger, metrics } = harness({
      recordings: [erasable(recordingRef), erasable(second)],
      deleteRecording: async ({ vendorConversationId: id }) => {
        if (id === vendorConversationId) throw new VoiceRecordingRequestError("rejected", 500);
        return "deleted";
      },
    });

    const prepared = await eraser.prepare({
      account: { id: accountId, deleted: false },
      scopes: [{ kind: "conversations", workspaceId, conversationIds: [conversationId, second.conversationId] }],
    });
    await expect(prepared.erase()).resolves.toBeUndefined();

    expect(audit.deleted.mock.calls.map(([event]) => event.conversationId)).toEqual([second.conversationId]);
    expect(logger.warn).toHaveBeenCalledWith(
      { workspaceId, conversationId, vendorConversationId, vendor: "elevenlabs", outcome: "vendor_failed", reason: "rejected", vendorStatus: 500 },
      "Voice recording was left at the vendor",
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(apiKey);
    expect(counted(metrics, "voice_recording_delete_total")).toEqual([
      { vendor: "elevenlabs", outcome: "vendor_failed" },
      { vendor: "elevenlabs", outcome: "deleted" },
    ]);
  });

  it("deletes a recording whose call never bound a conversation", async () => {
    const { eraser, source, audit } = harness({ recordings: [{ ...erasable(recordingRef), conversationId: null }] });

    await (await eraser.prepare(workspaceDeletion)).erase();

    expect(source.deleteRecording).toHaveBeenCalledTimes(1);
    expect(audit.deleted).toHaveBeenCalledWith(expect.objectContaining({ conversationId: null, outcome: "deleted" }));
  });

  it("leaves the recordings at the vendor, and says where, when the workspace's key cannot be read", async () => {
    const { eraser, source, logger, metrics } = harness({ credential: { kind: "missing" } });

    await (await eraser.prepare(workspaceDeletion)).erase();

    expect(source.deleteRecording).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      { workspaceId, conversationId, vendorConversationId, vendor: "elevenlabs", outcome: "credential_missing" },
      "Voice recording was left at the vendor",
    );
    expect(counted(metrics, "voice_recording_delete_total")).toEqual([{ vendor: "elevenlabs", outcome: "credential_missing" }]);
  });

  it("skips a scope whose recordings cannot be read, says so, and never fails the deletion", async () => {
    const { eraser, logger } = harness({ recordings: new Error("connection refused") });

    const prepared = await eraser.prepare(workspaceDeletion);

    await expect(prepared.erase()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith({ workspaceId, errorClass: "Error" }, "Voice recordings to delete could not be read");
  });

  it("works through an organization's workspaces in order under one budget, and names every recording it left past it", async () => {
    let clock = 0;
    const inOther: VoiceRecordingToErase = { ...erasable(second), workspaceId: otherWorkspaceId, vendorConversationId: "conv_other" };
    const third: VoiceRecordingToErase = { ...erasable(recordingRef), conversationId: "99999999-9999-4999-8999-999999999999", vendorConversationId: "conv_third", workspaceId: otherWorkspaceId };
    const { store, credentials, source, audit, metrics, logger } = harness();
    store.listRecordings.mockImplementation(async (scope) => (scope.workspaceId === workspaceId ? [erasable(recordingRef)] : [inOther, third]));
    source.deleteRecording.mockImplementation(async () => {
      clock += 1_000;
      return "deleted";
    });
    const eraser = new VoiceRecordingErasureService(
      { recordings: store, credentials, sources: { elevenlabs: source }, audit, metrics, logger },
      { deadlineMs: 1_500, concurrency: 1, now: () => clock },
    );

    await (await eraser.prepare({
      account: { id: accountId, deleted: true },
      scopes: [{ kind: "workspace", workspaceId }, { kind: "workspace", workspaceId: otherWorkspaceId }],
    })).erase();

    expect(source.deleteRecording.mock.calls.map(([input]) => input.vendorConversationId)).toEqual([vendorConversationId, "conv_other"]);
    expect(audit.deleted.mock.calls.map(([event]) => event.account)).toEqual([{ id: accountId, deleted: true }, { id: accountId, deleted: true }]);
    expect(logger.warn).toHaveBeenCalledWith(
      { workspaceId: otherWorkspaceId, conversationId: third.conversationId, vendorConversationId: "conv_third", vendor: "elevenlabs", outcome: "deadline_passed" },
      "Voice recording was left at the vendor",
    );
    expect(counted(metrics, "voice_recording_delete_total")).toContainEqual({ vendor: "elevenlabs", outcome: "deadline_passed" });
  });
});
