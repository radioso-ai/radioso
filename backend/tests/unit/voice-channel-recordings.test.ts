import { describe, expect, it, vi } from "vitest";

import {
  VoiceRecordingRequestError,
  type VoiceRecordingErasureBatch,
  type VoiceRecordingErasureHandOff,
  type VoiceRecordingErasureItem,
  type VoiceRecordingRef,
  type VoiceReportableSession,
  type VoiceRecordingSource,
  type VoiceRecordingStore,
  type VoiceRecordingStream,
  type VoiceRecordingToErase,
  type VoiceVendorCredentialPresence,
  type VoiceVendorCredentialReading,
} from "../../src/modules/voiceChannel/domain.js";
import {
  VoiceRecordingErasureDrain,
  VoiceRecordingErasureService,
  VoiceRecordingService,
  voiceRecordingErasureRequest,
  type VoiceRecordingAudit,
} from "../../src/modules/voiceChannel/public.js";

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
  recorded?: boolean;
  reportable?: VoiceReportableSession | null;
  describeConversation?: VoiceRecordingSource["describeConversation"];
  credential?: VoiceVendorCredentialReading | Error;
  stored?: VoiceVendorCredentialPresence | Error;
  fetchRecording?: VoiceRecordingSource["fetchRecording"];
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
    listRecordings: vi.fn<VoiceRecordingStore["listRecordings"]>(async () => []),
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
    deleteRecording: vi.fn<VoiceRecordingSource["deleteRecording"]>(async () => "deleted"),
  };
  const audit = {
    played: vi.fn<VoiceRecordingAudit["played"]>(overrides.played ?? (async () => undefined)),
  };
  const dependencies = { recordings: store, credentials, sources: { elevenlabs: source }, audit, metrics, logger };
  return {
    service: new VoiceRecordingService(dependencies),
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

describe("voice recording erasure hand-off", () => {
  const accountId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const second: VoiceRecordingRef = { ...recordingRef, conversationId: "88888888-8888-4888-8888-888888888888", vendorConversationId: "conv_second" };
  const workspaceDeletion = { accountId, scopes: [{ kind: "workspace" as const, workspaceId }] };

  const handOffHarness = (overrides: {
    recordings?: VoiceRecordingToErase[] | Error;
    credential?: VoiceVendorCredentialReading | Error;
  } = {}) => {
    const logger = { warn: vi.fn() };
    const recordings = {
      listRecordings: vi.fn<VoiceRecordingStore["listRecordings"]>(async () => {
        const listed = overrides.recordings ?? [erasable(recordingRef)];
        if (listed instanceof Error) throw listed;
        return listed;
      }),
    };
    const credentials = {
      read: vi.fn(async (): Promise<VoiceVendorCredentialReading> => {
        const credential = overrides.credential ?? { kind: "present", credential: { apiKey } };
        if (credential instanceof Error) throw credential;
        return credential;
      }),
    };
    const held: VoiceRecordingErasureHandOff[] = [];
    const backlog = { hold: vi.fn(async (handOff: VoiceRecordingErasureHandOff) => `erasure-${held.push(handOff)}`) };
    const sealer = { seal: vi.fn(({ apiKey: key }: { apiKey: string }) => `sealed(${key.length})`) };
    const jobs = { queue: vi.fn(async (_erasureId: string) => undefined), wake: vi.fn(async () => undefined) };
    const service = new VoiceRecordingErasureService({ recordings, backlog, credentials, sealer, jobs, logger });
    return { service, recordings, credentials, held, backlog, sealer, jobs, logger };
  };

  it("hands each recording to the backlog with the workspace's key sealed, queues its erasure, and wakes the job only after the commit", async () => {
    const { service, recordings, credentials, held, jobs } = handOffHarness({ recordings: [erasable(recordingRef), { ...erasable(second), conversationId: null }] });

    const handedOff = await service.handOff(workspaceDeletion);

    expect(recordings.listRecordings).toHaveBeenCalledWith({ kind: "workspace", workspaceId });
    expect(credentials.read).toHaveBeenCalledWith({ workspaceId, vendor: "elevenlabs" });
    expect(held).toEqual([{
      accountId,
      workspaceId,
      vendor: "elevenlabs",
      credential: { kind: "sealed", sealed: `sealed(${apiKey.length})` },
      recordings: [
        { conversationId, region: "eu", vendorConversationId },
        { conversationId: null, region: "eu", vendorConversationId: "conv_second" },
      ],
    }]);
    expect(JSON.stringify(held)).not.toContain(apiKey);
    expect(jobs.queue).toHaveBeenCalledWith("erasure-1");
    expect(jobs.wake).not.toHaveBeenCalled();

    await handedOff.afterCommit();
    expect(jobs.wake).toHaveBeenCalledTimes(1);
  });

  it("hands a call in two scopes off once, and each workspace's recordings with that workspace's key", async () => {
    const otherWorkspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const { service, recordings, held, jobs } = handOffHarness();
    recordings.listRecordings.mockImplementation(async (scope) => (scope.workspaceId === workspaceId
      ? [erasable(recordingRef)]
      : [{ ...erasable(second), workspaceId: otherWorkspaceId }]));

    await service.handOff({
      accountId,
      scopes: [
        { kind: "conversations", workspaceId, conversationIds: [conversationId] },
        { kind: "visitor_key", workspaceId, visitorKey: "visitor-key-1" },
        { kind: "workspace", workspaceId: otherWorkspaceId },
      ],
    });

    expect(held.map((handOff) => [handOff.workspaceId, handOff.recordings.map((recording) => recording.vendorConversationId)])).toEqual([
      [workspaceId, [vendorConversationId]],
      [otherWorkspaceId, ["conv_second"]],
    ]);
    expect(jobs.queue).toHaveBeenCalledTimes(2);
  });

  it("still hands off the recordings of a workspace with no key, or one the backend cannot decrypt, saying why", async () => {
    for (const [credential, reason] of [[{ kind: "missing" }, "credential_missing"], [{ kind: "unreadable" }, "credential_unreadable"]] as const) {
      const { service, held, sealer } = handOffHarness({ credential });

      await service.handOff(workspaceDeletion);

      expect(held.map((handOff) => handOff.credential)).toEqual([{ kind: "absent", reason }]);
      expect(sealer.seal).not.toHaveBeenCalled();
    }
  });

  it("fails the deletion when the recordings or the key cannot be read, so it runs again, and logs ids only", async () => {
    for (const scope of [
      { kind: "workspace" as const, workspaceId },
      { kind: "conversations" as const, workspaceId, conversationIds: [conversationId] },
      { kind: "visitor_key" as const, workspaceId, visitorKey: "visitor-key-1" },
    ]) {
      const { service, logger, held } = handOffHarness({ recordings: new Error("connection refused") });

      await expect(service.handOff({ accountId, scopes: [scope] })).rejects.toThrow("connection refused");
      expect(logger.warn).toHaveBeenCalledWith({ workspaceId, scope: scope.kind, errorClass: "Error" }, "Voice recordings to delete could not be read");
      expect(held).toEqual([]);
    }
    const { service, logger, held } = handOffHarness({ credential: new Error("connection refused") });
    await expect(service.handOff(workspaceDeletion)).rejects.toThrow("connection refused");
    expect(logger.warn).toHaveBeenCalledWith({ workspaceId, vendor: "elevenlabs", errorClass: "Error" }, "Voice vendor key to delete recordings with could not be read");
    expect(held).toEqual([]);
  });

  it("hands nothing off, and wakes nothing, when the scope holds no recording", async () => {
    const { service, backlog, jobs } = handOffHarness({ recordings: [] });

    await (await service.handOff(workspaceDeletion)).afterCommit();

    expect(backlog.hold).not.toHaveBeenCalled();
    expect(jobs.queue).not.toHaveBeenCalled();
    expect(jobs.wake).not.toHaveBeenCalled();
  });
});

describe("voice recording erasure job", () => {
  const accountId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const erasureId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const item = (overrides: Partial<VoiceRecordingErasureItem> = {}): VoiceRecordingErasureItem => ({
    id: `item-${overrides.vendorConversationId ?? vendorConversationId}`,
    conversationId,
    region: "eu",
    vendorConversationId,
    attempts: 1,
    failureReason: null,
    ...overrides,
  });
  const batchOf = (items: VoiceRecordingErasureItem[], overrides: Partial<VoiceRecordingErasureBatch> = {}): VoiceRecordingErasureBatch => ({
    account: { id: accountId, deleted: false },
    workspace: { id: workspaceId, deleted: true },
    vendor: "elevenlabs",
    sealedCredential: "sealed-key",
    items,
    ...overrides,
  });

  const drainHarness = (options: {
    batch?: VoiceRecordingErasureBatch | null;
    remaining?: { pending: number; neverAsked: number };
    deleteRecording?: VoiceRecordingSource["deleteRecording"];
    open?: (sealed: string) => { apiKey: string };
    deleted?: VoiceRecordingAudit["deleted"];
  } = {}) => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    const metrics = { incrementCounter: vi.fn() };
    const backlog = {
      hold: vi.fn(async () => "unused"),
      claim: vi.fn(async () => (options.batch === undefined ? batchOf([item()]) : options.batch)),
      remove: vi.fn(async (_itemId: string) => undefined),
      keep: vi.fn(async (_itemId: string, _reason: string) => undefined),
      fail: vi.fn(async (_itemId: string, _reason: string) => undefined),
      release: vi.fn(async () => options.remaining ?? { pending: 0, neverAsked: 0 }),
      failRemaining: vi.fn(async (): Promise<VoiceRecordingErasureBatch | null> => null),
    };
    const source = { deleteRecording: vi.fn<VoiceRecordingSource["deleteRecording"]>(options.deleteRecording ?? (async () => "deleted")) };
    const audit = {
      deleted: vi.fn<VoiceRecordingAudit["deleted"]>(options.deleted ?? (async () => undefined)),
      left: vi.fn<VoiceRecordingAudit["left"]>(async () => undefined),
    };
    const queue = { enqueue: vi.fn(async () => ({ inserted: false as const })) };
    const sealer = { open: vi.fn(options.open ?? (() => ({ apiKey }))) };
    const drain = new VoiceRecordingErasureDrain({
      backlog,
      backlogIn: () => backlog,
      sealer,
      sources: { elevenlabs: source },
      audit,
      queue,
      metrics,
      logger,
    });
    return { drain, backlog, source, audit, queue, sealer, metrics, logger };
  };
  const signal = () => new AbortController().signal;

  it("deletes each recording at the vendor with the held key, records it for the organization, and removes it from the backlog", async () => {
    const { drain, backlog, source, audit, metrics, queue } = drainHarness({
      batch: batchOf([item(), item({ vendorConversationId: "conv_second", conversationId: null })]),
    });

    await drain.run(erasureId, signal());

    expect(backlog.claim).toHaveBeenCalledWith(erasureId, 50);
    expect(source.deleteRecording.mock.calls.map(([input]) => [input.vendorConversationId, input.region, input.credential])).toEqual([
      [vendorConversationId, "eu", { apiKey }],
      ["conv_second", "eu", { apiKey }],
    ]);
    expect(audit.deleted.mock.calls.map(([event]) => event)).toEqual([
      { account: { id: accountId, deleted: false }, workspaceId, workspaceDeleted: true, conversationId, vendor: "elevenlabs", outcome: "deleted" },
      { account: { id: accountId, deleted: false }, workspaceId, workspaceDeleted: true, conversationId: null, vendor: "elevenlabs", outcome: "deleted" },
    ]);
    expect(backlog.remove.mock.calls.map(([id]) => id)).toEqual([`item-${vendorConversationId}`, "item-conv_second"]);
    expect(backlog.release).toHaveBeenCalledWith(erasureId);
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(counted(metrics, "voice_recording_delete_total")).toEqual([
      { vendor: "elevenlabs", outcome: "deleted" },
      { vendor: "elevenlabs", outcome: "deleted" },
    ]);
  });

  it("counts a recording the vendor no longer held as done, and records it as already absent", async () => {
    const { drain, audit, backlog } = drainHarness({ deleteRecording: async () => "already_absent" });

    await drain.run(erasureId, signal());

    expect(audit.deleted.mock.calls.map(([event]) => event.outcome)).toEqual(["already_absent"]);
    expect(backlog.remove).toHaveBeenCalledTimes(1);
  });

  it("keeps a refused recording for another ask, and waits out the backoff once no recording is left unasked", async () => {
    const { drain, backlog, audit, metrics, logger } = drainHarness({
      deleteRecording: async () => { throw new VoiceRecordingRequestError("rejected", 503); },
      remaining: { pending: 1, neverAsked: 0 },
    });

    await expect(drain.run(erasureId, signal())).rejects.toThrow("still at the vendor");

    expect(backlog.keep).toHaveBeenCalledWith(`item-${vendorConversationId}`, "vendor_rejected");
    expect(backlog.fail).not.toHaveBeenCalled();
    expect(audit.deleted).not.toHaveBeenCalled();
    expect(audit.left).not.toHaveBeenCalled();
    expect(counted(metrics, "voice_recording_delete_total")).toEqual([{ vendor: "elevenlabs", outcome: "vendor_failed" }]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ erasureId, retrying: 1, pending: 1, firstHeld: { outcome: "vendor_rejected", reason: "rejected", vendorStatus: 503 } }),
      "Voice recording erasure left recordings at the vendor",
    );
  });

  it("asks for another run at once while recordings never asked about remain", async () => {
    const { drain, queue } = drainHarness({
      deleteRecording: async () => { throw new VoiceRecordingRequestError("unreachable"); },
      remaining: { pending: 60, neverAsked: 59 },
    });

    await drain.run(erasureId, signal());

    expect(queue.enqueue).toHaveBeenCalledWith(voiceRecordingErasureRequest(erasureId));
  });

  it("leaves a recording at the vendor once its asks run out: marks it failed, logs where it is, and records why", async () => {
    const { drain, backlog, audit, metrics, logger } = drainHarness({
      batch: batchOf([item({ attempts: 8 })], { workspace: { id: workspaceId, deleted: false } }),
      deleteRecording: async () => { throw new VoiceRecordingRequestError("timeout"); },
    });

    await drain.run(erasureId, signal());

    expect(backlog.fail).toHaveBeenCalledWith(`item-${vendorConversationId}`, "vendor_timeout");
    expect(backlog.keep).not.toHaveBeenCalled();
    expect(audit.left).toHaveBeenCalledWith({
      account: { id: accountId, deleted: false },
      workspaceId,
      workspaceDeleted: false,
      conversationId,
      vendor: "elevenlabs",
      vendorConversationId,
      reason: "vendor_timeout",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      { workspaceId, conversationId, vendorConversationId, vendor: "elevenlabs", outcome: "vendor_timeout", attempts: 8, reason: "timeout" },
      "Voice recording was left at the vendor",
    );
    expect(JSON.stringify([logger.warn.mock.calls, logger.info.mock.calls, audit.left.mock.calls])).not.toContain(apiKey);
    expect(counted(metrics, "voice_recording_delete_total")).toEqual([
      { vendor: "elevenlabs", outcome: "vendor_failed" },
      { vendor: "elevenlabs", outcome: "left_at_vendor" },
    ]);
  });

  it("leaves the recordings of a deletion that found no key at the vendor, without asking", async () => {
    const { drain, backlog, source, audit } = drainHarness({
      batch: batchOf([item({ failureReason: "credential_missing" })], { sealedCredential: null }),
    });

    await drain.run(erasureId, signal());

    expect(source.deleteRecording).not.toHaveBeenCalled();
    expect(backlog.fail).toHaveBeenCalledWith(`item-${vendorConversationId}`, "credential_missing");
    expect(audit.left).toHaveBeenCalledWith(expect.objectContaining({ reason: "credential_missing" }));
  });

  it("counts a held key that no longer opens as a failed ask", async () => {
    const { drain, backlog, source } = drainHarness({
      open: () => { throw new Error("Unsupported state or unable to authenticate data"); },
      remaining: { pending: 1, neverAsked: 0 },
    });

    await expect(drain.run(erasureId, signal())).rejects.toThrow();

    expect(source.deleteRecording).not.toHaveBeenCalled();
    expect(backlog.keep).toHaveBeenCalledWith(`item-${vendorConversationId}`, "credential_unreadable");
  });

  it("still removes a recording the vendor deleted when its record cannot be written, and says so", async () => {
    const { drain, backlog, logger } = drainHarness({ deleted: async () => { throw new Error("connection refused"); } });

    await drain.run(erasureId, signal());

    expect(backlog.remove).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      { workspaceId, conversationId, vendor: "elevenlabs", errorClass: "Error" },
      "Voice recording deletion could not be audited",
    );
  });

  it("does nothing for an erasure an earlier run drained", async () => {
    const { drain, backlog, source } = drainHarness({ batch: null });

    await drain.run(erasureId, signal());

    expect(source.deleteRecording).not.toHaveBeenCalled();
    expect(backlog.release).not.toHaveBeenCalled();
  });

  it("gives up on every recording still pending once the job itself kept failing, each with why", async () => {
    const { drain, backlog, audit, metrics } = drainHarness();
    backlog.failRemaining.mockResolvedValue(batchOf([
      item({ failureReason: "vendor_unreachable" }),
      item({ vendorConversationId: "conv_second", failureReason: "drain_failed", attempts: 0 }),
    ]));
    const transaction = {} as Parameters<VoiceRecordingErasureDrain["giveUp"]>[1];

    await drain.giveUp(erasureId, transaction);

    expect(backlog.failRemaining).toHaveBeenCalledWith(erasureId);
    expect(audit.left.mock.calls.map(([event]) => [event.vendorConversationId, event.reason])).toEqual([
      [vendorConversationId, "vendor_unreachable"],
      ["conv_second", "drain_failed"],
    ]);
    expect(counted(metrics, "voice_recording_delete_total")).toEqual([
      { vendor: "elevenlabs", outcome: "left_at_vendor" },
      { vendor: "elevenlabs", outcome: "left_at_vendor" },
    ]);
  });
});
