import { describe, expect, it, vi } from "vitest";

import {
  VoiceRecordingRequestError,
  type VoiceRecordingRef,
  type VoiceRecordingSource,
  type VoiceRecordingStore,
  type VoiceRecordingStream,
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

const audioStream = (): VoiceRecordingStream => ({
  status: 200,
  body: new ReadableStream({ start: (controller) => controller.close() }),
  contentType: "audio/mpeg",
  contentLength: 0,
});

const harness = (overrides: {
  recording?: VoiceRecordingRef | null | Error;
  recordings?: VoiceRecordingRef[] | Error;
  recorded?: boolean;
  credential?: VoiceVendorCredentialReading | Error;
  stored?: VoiceVendorCredentialPresence | Error;
  fetchRecording?: VoiceRecordingSource["fetchRecording"];
  deleteRecording?: VoiceRecordingSource["deleteRecording"];
  played?: VoiceRecordingAudit["played"];
} = {}) => {
  const logger = { warn: vi.fn(), info: vi.fn() };
  const metrics = { incrementCounter: vi.fn() };
  const store = {
    recordVendorConversation: vi.fn<VoiceRecordingStore["recordVendorConversation"]>(async () => overrides.recorded ?? true),
    findRecording: vi.fn<VoiceRecordingStore["findRecording"]>(async () => {
      const recording = overrides.recording === undefined ? recordingRef : overrides.recording;
      if (recording instanceof Error) throw recording;
      return recording;
    }),
    listRecordings: vi.fn<VoiceRecordingStore["listRecordings"]>(async () => {
      const recordings = overrides.recordings ?? [recordingRef];
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
    fetchRecording: vi.fn<VoiceRecordingSource["fetchRecording"]>(overrides.fetchRecording ?? (async () => audioStream())),
    deleteRecording: vi.fn<VoiceRecordingSource["deleteRecording"]>(overrides.deleteRecording ?? (async () => undefined)),
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

  it("stores the vendor's conversation id for the session the public session started", async () => {
    const { service, store } = harness();

    await expect(service.report(report)).resolves.toBe("recorded");
    expect(store.recordVendorConversation).toHaveBeenCalledWith(report);
  });

  it("refuses a report no started session waits for, and logs ids only", async () => {
    const { service, logger } = harness({ recorded: false });

    await expect(service.report(report)).resolves.toBe("rejected");
    expect(logger.warn).toHaveBeenCalledWith({ workspaceId, agentId }, "Voice vendor conversation report was refused");
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(vendorConversationId);
  });
});

describe("voice recording availability", () => {
  it("is available when the conversation's session has a vendor conversation and the workspace holds a readable key", async () => {
    const { service, credentials, source } = harness();

    await expect(service.isAvailable({ workspaceId, conversationId })).resolves.toBe(true);
    expect(credentials.presence).toHaveBeenCalledWith({ workspaceId, vendor: "elevenlabs" });
    expect(credentials.read).not.toHaveBeenCalled();
    expect(source.fetchRecording).not.toHaveBeenCalled();
  });

  it.each([
    ["the conversation has no reported vendor conversation", { recording: null }],
    ["the workspace holds no key for the vendor", { stored: "missing" as const }],
    ["the backend cannot decrypt the key", { stored: "unreadable" as const }],
  ])("is not available when %s", async (_case, overrides) => {
    await expect(harness(overrides).service.isAvailable({ workspaceId, conversationId })).resolves.toBe(false);
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
    expect(audit.played).toHaveBeenCalledWith({ workspaceId, conversationId, actorUserId, vendor: "elevenlabs", partial: true });
    expect(counted(metrics, "voice_recording_fetch_total")).toEqual([{ vendor: "elevenlabs", outcome: "served" }]);
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
  const second: VoiceRecordingRef = { ...recordingRef, conversationId: "88888888-8888-4888-8888-888888888888", vendorConversationId: "conv_second" };

  it("reads the recordings and the key while they exist, and deletes each at the vendor once erase runs, auditing each", async () => {
    const { eraser, store, credentials, source, audit, metrics } = harness({ recordings: [recordingRef, second] });
    const scope = { kind: "workspace" as const, workspaceId };

    const prepared = await eraser.prepare(scope);

    expect(prepared.recordingCount).toBe(2);
    expect(store.listRecordings).toHaveBeenCalledWith(scope);
    expect(credentials.read).toHaveBeenCalledWith({ workspaceId, vendor: "elevenlabs" });
    expect(source.deleteRecording).not.toHaveBeenCalled();

    await prepared.erase();

    expect(source.deleteRecording.mock.calls.map(([input]) => input)).toEqual([
      { vendorConversationId, region: "eu", credential: { apiKey } },
      { vendorConversationId: "conv_second", region: "eu", credential: { apiKey } },
    ]);
    expect(audit.deleted.mock.calls.map(([event]) => event)).toEqual([
      { workspaceId, workspaceDeleted: true, conversationId, vendor: "elevenlabs" },
      { workspaceId, workspaceDeleted: true, conversationId: second.conversationId, vendor: "elevenlabs" },
    ]);
    expect(counted(metrics, "voice_recording_delete_total")).toEqual([
      { vendor: "elevenlabs", outcome: "deleted" },
      { vendor: "elevenlabs", outcome: "deleted" },
    ]);
  });

  it("keeps going past a recording the vendor would not delete, logs it with ids only, and never rejects", async () => {
    const { eraser, audit, logger, metrics } = harness({
      recordings: [recordingRef, second],
      deleteRecording: async ({ vendorConversationId: id }) => {
        if (id === vendorConversationId) throw new VoiceRecordingRequestError("rejected", 500);
      },
    });

    const prepared = await eraser.prepare({ kind: "conversations", workspaceId, conversationIds: [conversationId, second.conversationId] });
    await expect(prepared.erase()).resolves.toBeUndefined();

    expect(audit.deleted.mock.calls.map(([event]) => event.conversationId)).toEqual([second.conversationId]);
    expect(logger.warn).toHaveBeenCalledWith(
      { workspaceId, conversationId, vendor: "elevenlabs", outcome: "vendor_failed", reason: "rejected", vendorStatus: 500 },
      "Voice recording was left at the vendor",
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(apiKey);
    expect(counted(metrics, "voice_recording_delete_total")).toEqual([
      { vendor: "elevenlabs", outcome: "vendor_failed" },
      { vendor: "elevenlabs", outcome: "deleted" },
    ]);
  });

  it("leaves the recordings at the vendor, and says so, when the workspace's key cannot be read", async () => {
    const { eraser, source, logger, metrics } = harness({ credential: { kind: "missing" } });

    const prepared = await eraser.prepare({ kind: "workspace", workspaceId });
    await prepared.erase();

    expect(source.deleteRecording).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      { workspaceId, conversationId, vendor: "elevenlabs", outcome: "credential_missing" },
      "Voice recording was left at the vendor",
    );
    expect(counted(metrics, "voice_recording_delete_total")).toEqual([{ vendor: "elevenlabs", outcome: "credential_missing" }]);
  });

  it("prepares nothing, and never fails the deletion, when the session store cannot be read", async () => {
    const { eraser, logger } = harness({ recordings: new Error("connection refused") });

    const prepared = await eraser.prepare({ kind: "workspace", workspaceId });


    expect(prepared.recordingCount).toBe(0);
    await expect(prepared.erase()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith({ workspaceId, errorClass: "Error" }, "Voice recordings to delete could not be read");
  });

  it("stops asking the vendor once its time is up, and says how many recordings it left there", async () => {
    let clock = 0;
    const third: VoiceRecordingRef = { ...recordingRef, conversationId: "99999999-9999-4999-8999-999999999999", vendorConversationId: "conv_third" };
    const { store, credentials, source, audit, metrics, logger } = harness({ recordings: [recordingRef, second, third] });
    source.deleteRecording.mockImplementation(async () => {
      clock += 1_000;
    });
    const eraser = new VoiceRecordingErasureService(
      { recordings: store, credentials, sources: { elevenlabs: source }, audit, metrics, logger },
      { deadlineMs: 1_500, concurrency: 1, now: () => clock },
    );

    await (await eraser.prepare({ kind: "workspace", workspaceId })).erase();

    expect(source.deleteRecording).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      { workspaceId, outcome: "deadline_passed", recordingCount: 1 },
      "Voice recordings were left at the vendor",
    );
    expect(counted(metrics, "voice_recording_delete_total")).toContainEqual({ vendor: "elevenlabs", outcome: "deadline_passed" });
  });
});
