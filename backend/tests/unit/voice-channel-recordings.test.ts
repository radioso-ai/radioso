import { describe, expect, it, vi } from "vitest";

import {
  VoiceRecordingRequestError,
  type VoiceRecordingErasureBacklog,
  type VoiceRecordingErasureClaim,
  type VoiceRecordingErasureHandOff,
  type VoiceRecordingErasureItem,
  type VoiceRecordingLeftReason,
  type VoiceRecordingRef,
  type VoiceReportableSession,
  type VoiceRecordingSource,
  type VoiceRecordingStore,
  type VoiceRecordingStream,
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
    lockRecordedVendors: vi.fn<VoiceRecordingStore["lockRecordedVendors"]>(async () => []),
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
  const workspaceScope = { kind: "workspace" as const, workspaceId };
  const workspaceDeletion = { accountId, scopes: [workspaceScope] };

  const handOffHarness = (overrides: {
    vendors?: Array<"elevenlabs"> | Error;
    credential?: VoiceVendorCredentialReading | Error;
    held?: number;
  } = {}) => {
    const logger = { warn: vi.fn() };
    const recordings = {
      lockRecordedVendors: vi.fn<VoiceRecordingStore["lockRecordedVendors"]>(async () => {
        const vendors = overrides.vendors ?? ["elevenlabs"];
        if (vendors instanceof Error) throw vendors;
        return vendors;
      }),
    };
    const credentials = {
      read: vi.fn(async (): Promise<VoiceVendorCredentialReading> => {
        const credential = overrides.credential ?? { kind: "present", credential: { apiKey } };
        if (credential instanceof Error) throw credential;
        return credential;
      }),
    };
    const handOffs: VoiceRecordingErasureHandOff[] = [];
    const backlog = {
      hold: vi.fn(async (handOff: VoiceRecordingErasureHandOff) => {
        handOffs.push(handOff);
        const recordingCount = overrides.held ?? 2;
        return recordingCount === 0 ? null : { erasureId: `erasure-${handOffs.length}`, recordings: recordingCount };
      }),
    };
    const sealer = { seal: vi.fn(({ apiKey: key }: { apiKey: string }) => `sealed(${key.length})`) };
    const jobs = { queue: vi.fn(async (_erasureId: string) => undefined), wake: vi.fn(async () => undefined) };
    const service = new VoiceRecordingErasureService({ recordings, backlog, credentials, sealer, jobs, logger });
    return { service, recordings, credentials, handOffs, backlog, sealer, jobs, logger };
  };

  it("locks the scope, hands its recordings to the backlog with the workspace's key sealed, queues the erasure, and wakes the job only after the commit", async () => {
    const { service, recordings, credentials, handOffs, jobs } = handOffHarness();

    const handedOff = await service.handOff(workspaceDeletion);

    expect(recordings.lockRecordedVendors).toHaveBeenCalledWith(workspaceScope);
    expect(credentials.read).toHaveBeenCalledWith({ workspaceId, vendor: "elevenlabs" });
    expect(handOffs).toEqual([{
      accountId,
      workspaceId,
      vendor: "elevenlabs",
      scope: workspaceScope,
      credential: { kind: "sealed", sealed: `sealed(${apiKey.length})` },
    }]);
    expect(JSON.stringify(handOffs)).not.toContain(apiKey);
    expect(jobs.queue).toHaveBeenCalledWith("erasure-1");
    expect(jobs.wake).not.toHaveBeenCalled();

    await handedOff.afterCommit();
    expect(jobs.wake).toHaveBeenCalledTimes(1);
  });

  it("hands off each scope of an erasure with that scope's workspace key", async () => {
    const otherWorkspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const { service, handOffs, jobs } = handOffHarness();

    await service.handOff({
      accountId,
      scopes: [
        { kind: "conversations", workspaceId, conversationIds: [conversationId] },
        { kind: "visitor_key", workspaceId, visitorKey: "visitor-key-1" },
        { kind: "workspace", workspaceId: otherWorkspaceId },
      ],
    });

    expect(handOffs.map((handOff) => [handOff.workspaceId, handOff.scope.kind])).toEqual([
      [workspaceId, "conversations"],
      [workspaceId, "visitor_key"],
      [otherWorkspaceId, "workspace"],
    ]);
    expect(jobs.queue).toHaveBeenCalledTimes(3);
  });

  it("still hands off the recordings of a workspace with no key, or one the backend cannot decrypt, saying why", async () => {
    for (const [credential, reason] of [[{ kind: "missing" }, "credential_missing"], [{ kind: "unreadable" }, "credential_unreadable"]] as const) {
      const { service, handOffs, sealer } = handOffHarness({ credential });

      await service.handOff(workspaceDeletion);

      expect(handOffs.map((handOff) => handOff.credential)).toEqual([{ kind: "absent", reason }]);
      expect(sealer.seal).not.toHaveBeenCalled();
    }
  });

  it("fails the deletion when the recordings or the key cannot be read, so it runs again, and logs ids only", async () => {
    for (const scope of [
      workspaceScope,
      { kind: "conversations" as const, workspaceId, conversationIds: [conversationId] },
      { kind: "visitor_key" as const, workspaceId, visitorKey: "visitor-key-1" },
    ]) {
      const { service, logger, handOffs } = handOffHarness({ vendors: new Error("connection refused") });

      await expect(service.handOff({ accountId, scopes: [scope] })).rejects.toThrow("connection refused");
      expect(logger.warn).toHaveBeenCalledWith({ workspaceId, scope: scope.kind, errorClass: "Error" }, "Voice recordings to delete could not be read");
      expect(handOffs).toEqual([]);
    }
    const { service, logger, handOffs } = handOffHarness({ credential: new Error("connection refused") });
    await expect(service.handOff(workspaceDeletion)).rejects.toThrow("connection refused");
    expect(logger.warn).toHaveBeenCalledWith({ workspaceId, vendor: "elevenlabs", errorClass: "Error" }, "Voice vendor key to delete recordings with could not be read");
    expect(handOffs).toEqual([]);
  });

  it("queues and wakes nothing when the scope holds no recording, or none a pending row does not already hold", async () => {
    for (const harness of [handOffHarness({ vendors: [] }), handOffHarness({ held: 0 })]) {
      await (await harness.service.handOff(workspaceDeletion)).afterCommit();

      expect(harness.jobs.queue).not.toHaveBeenCalled();
      expect(harness.jobs.wake).not.toHaveBeenCalled();
    }
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
  const givenUpEntry = (reason: VoiceRecordingLeftReason, index: number) => ({
    id: `given-up-${index}`,
    conversationId: null,
    vendorConversationId: `conv_given_up_${index}`,
    attempts: 0,
    failureReason: reason,
  });
  const erasureSubject = { accountId, workspaceId, vendor: "elevenlabs", sealedCredential: "sealed-key" as string | null };
  const batchOf = (
    items: VoiceRecordingErasureItem[],
    overrides: { sealedCredential?: string | null; vendor?: string; givenUp?: Extract<VoiceRecordingErasureClaim, { kind: "batch" }>["givenUp"] } = {},
  ): VoiceRecordingErasureClaim => ({
    kind: "batch",
    erasure: {
      ...erasureSubject,
      ...(overrides.sealedCredential === undefined ? {} : { sealedCredential: overrides.sealedCredential }),
      ...(overrides.vendor ? { vendor: overrides.vendor } : {}),
    },
    items,
    givenUp: overrides.givenUp ?? [],
  });

  const drainHarness = (options: {
    claim?: VoiceRecordingErasureClaim;
    remaining?: { pending: number; nextAskAt: Date | null; dueNow: boolean };
    deleteRecording?: VoiceRecordingSource["deleteRecording"];
    open?: (sealed: string) => { apiKey: string };
    deleted?: VoiceRecordingAudit["deleted"];
    failChanges?: boolean;
  } = {}) => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    const metrics = { incrementCounter: vi.fn() };
    const errorReporter = { report: vi.fn(async (_input: { errorType: string; metadata?: Record<string, unknown> }) => undefined) };
    const backlog = {
      hold: vi.fn(async () => null),
      claim: vi.fn(async (_erasureId: string, _claim: { limit: number; leaseSeconds: number; expireAfterSeconds: number }): Promise<VoiceRecordingErasureClaim> => options.claim ?? batchOf([item()])),
      remove: vi.fn(async (_itemId: string) => undefined),
      keep: vi.fn(async (_itemId: string, _reason: string, _delaySeconds: number) => undefined),
      postpone: vi.fn(async (_itemIds: readonly string[], _delaySeconds: number) => undefined),
      fail: vi.fn(async (_itemId: string, _reason: string) => options.failChanges ?? true),
      release: vi.fn(async () => options.remaining ?? { pending: 0, nextAskAt: null, dueNow: false }),
      failExhausted: vi.fn<VoiceRecordingErasureBacklog["failExhausted"]>(async () => null),
      overdueErasures: vi.fn(async () => []),
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
      errorReporter,
      metrics,
      logger,
    });
    return { drain, backlog, source, audit, queue, sealer, metrics, logger, errorReporter };
  };
  const signal = () => new AbortController().signal;
  const leftValues = (metrics: { incrementCounter: ReturnType<typeof vi.fn> }) => metrics.incrementCounter.mock.calls
    .map(([, options]) => options as { labels: Record<string, string>; value?: number })
    .filter((options) => options.labels.outcome === "left_at_vendor")
    .map((options) => options.value ?? 1);

  it("deletes each recording at the vendor with the held key, records it for the organization, and removes it from the backlog", async () => {
    const { drain, backlog, source, audit, metrics, queue, errorReporter } = drainHarness({
      claim: batchOf([item(), item({ vendorConversationId: "conv_second", conversationId: null })]),
    });

    await drain.run(erasureId, signal());

    expect(backlog.claim).toHaveBeenCalledWith(erasureId, { limit: 50, leaseSeconds: 300, expireAfterSeconds: 7 * 24 * 60 * 60 });
    expect(source.deleteRecording.mock.calls.map(([input]) => [input.vendorConversationId, input.region, input.credential])).toEqual([
      [vendorConversationId, "eu", { apiKey }],
      ["conv_second", "eu", { apiKey }],
    ]);
    expect(audit.deleted.mock.calls.map(([event]) => event)).toEqual([
      { accountId, workspaceId, conversationId, vendor: "elevenlabs", outcome: "deleted" },
      { accountId, workspaceId, conversationId: null, vendor: "elevenlabs", outcome: "deleted" },
    ]);
    expect(backlog.remove.mock.calls.map(([id]) => id)).toEqual([`item-${vendorConversationId}`, "item-conv_second"]);
    expect(backlog.release).toHaveBeenCalledWith(erasureId);
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(errorReporter.report).not.toHaveBeenCalled();
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

  it("keeps a refused recording for its next ask on the schedule, or later when the vendor says so, and queues a run for then without failing", async () => {
    const nextAskAt = new Date(Date.now() + 300_000);
    const { drain, backlog, audit, metrics, logger, queue } = drainHarness({
      claim: batchOf([item({ attempts: 2 }), item({ vendorConversationId: "conv_slow", attempts: 1 })]),
      deleteRecording: async ({ vendorConversationId: id }) => {
        throw id === "conv_slow" ? new VoiceRecordingRequestError("rejected", 503, undefined, 1_200) : new VoiceRecordingRequestError("rejected", 500);
      },
      remaining: { pending: 2, nextAskAt, dueNow: false },
    });

    await expect(drain.run(erasureId, signal())).resolves.toBeUndefined();

    expect(backlog.keep.mock.calls).toEqual([
      [`item-${vendorConversationId}`, "vendor_rejected", 300],
      ["item-conv_slow", "vendor_rejected", 1_200],
    ]);
    expect(backlog.fail).not.toHaveBeenCalled();
    expect(audit.left).not.toHaveBeenCalled();
    expect(queue.enqueue).toHaveBeenCalledWith(voiceRecordingErasureRequest(erasureId, nextAskAt));
    expect(counted(metrics, "voice_recording_delete_total")).toEqual([
      { vendor: "elevenlabs", outcome: "vendor_failed" },
      { vendor: "elevenlabs", outcome: "vendor_failed" },
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ erasureId, retrying: 2, pending: 2, firstHeld: { outcome: "vendor_rejected", reason: "rejected", vendorStatus: 500 } }),
      "Voice recording erasure left recordings at the vendor",
    );
  });

  it("queues another run at once while more recordings are due", async () => {
    const { drain, queue } = drainHarness({ remaining: { pending: 60, nextAskAt: new Date(), dueNow: true } });

    await drain.run(erasureId, signal());

    expect(queue.enqueue).toHaveBeenCalledWith(voiceRecordingErasureRequest(erasureId));
  });

  it("keys a later run by its minute, rounded up, so it waits as its own job", () => {
    const at = new Date("2026-10-25T12:00:05.000Z");

    expect(voiceRecordingErasureRequest(erasureId, at)).toMatchObject({
      idempotencyKey: `${erasureId}@2026-10-25T12:01:00.000Z`,
      runAfter: new Date("2026-10-25T12:01:00.000Z"),
      payload: { erasureId },
    });
    expect(voiceRecordingErasureRequest(erasureId)).toMatchObject({ idempotencyKey: erasureId, payload: { erasureId } });
  });

  it("stops asking a vendor that answers 429, and postpones every recording it turned away or never reached for its Retry-After, none counted", async () => {
    const items = Array.from({ length: 10 }, (_, index) => item({ vendorConversationId: `conv_${index}` }));
    const { drain, backlog, source, metrics } = drainHarness({
      claim: batchOf(items),
      deleteRecording: async () => {
        await Promise.resolve();
        throw new VoiceRecordingRequestError("rejected", 429, undefined, 900);
      },
      remaining: { pending: 10, nextAskAt: new Date(Date.now() + 900_000), dueNow: false },
    });

    await drain.run(erasureId, signal());

    expect(source.deleteRecording.mock.calls.length).toBeLessThanOrEqual(4);
    expect(backlog.keep).not.toHaveBeenCalled();
    expect(backlog.postpone).toHaveBeenCalledTimes(1);
    const [postponed, delay] = backlog.postpone.mock.calls[0];
    expect([...postponed].sort()).toEqual(items.map((entry) => entry.id).sort());
    expect(delay).toBe(900);
    expect(counted(metrics, "voice_recording_delete_total").every((labels) => labels.outcome === "rate_limited")).toBe(true);
  });

  it("pauses for a minute when a 429 names no Retry-After, and for at most an hour when it names a longer one", async () => {
    for (const [retryAfter, expected] of [[undefined, 60], [86_400, 3_600], [120, 120]] as const) {
      const { drain, backlog } = drainHarness({
        deleteRecording: async () => { throw new VoiceRecordingRequestError("rejected", 429, undefined, retryAfter); },
        remaining: { pending: 1, nextAskAt: new Date(Date.now() + 60_000), dueNow: false },
      });

      await drain.run(erasureId, signal());

      expect(backlog.postpone.mock.calls[0]?.[1]).toBe(expected);
    }
  });

  it("leaves a recording at the vendor once its eighth ask is refused: marks it failed, logs where it is, records why, and reports to staff", async () => {
    const { drain, backlog, audit, metrics, logger, errorReporter } = drainHarness({
      claim: batchOf([item({ attempts: 8 })]),
      deleteRecording: async () => { throw new VoiceRecordingRequestError("timeout"); },
    });

    await drain.run(erasureId, signal());

    expect(backlog.fail).toHaveBeenCalledWith(`item-${vendorConversationId}`, "vendor_timeout");
    expect(backlog.keep).not.toHaveBeenCalled();
    expect(audit.left).toHaveBeenCalledWith({
      accountId,
      workspaceId,
      vendor: "elevenlabs",
      recordings: [{ conversationId, vendorConversationId, reason: "vendor_timeout" }],
    });
    expect(logger.warn).toHaveBeenCalledWith(
      { workspaceId, conversationId, vendorConversationId, vendor: "elevenlabs", outcome: "vendor_timeout", attempts: 8, reason: "timeout" },
      "Voice recording was left at the vendor",
    );
    expect(errorReporter.report).toHaveBeenCalledWith({
      errorType: "voice.recording_left_at_vendor",
      severity: "warn",
      correlation: { workspaceId },
      metadata: { erasureId, accountId, vendor: "elevenlabs", leftAtVendor: 1, reasons: { vendor_timeout: 1 } },
    });
    expect(JSON.stringify([logger.warn.mock.calls, logger.info.mock.calls, audit.left.mock.calls, errorReporter.report.mock.calls])).not.toContain(apiKey);
    expect(counted(metrics, "voice_recording_delete_total")).toEqual([
      { vendor: "elevenlabs", outcome: "vendor_failed" },
      { vendor: "elevenlabs", outcome: "left_at_vendor" },
    ]);
  });

  it("records nothing for a recording another run already gave up on", async () => {
    const { drain, audit, metrics, errorReporter } = drainHarness({
      claim: batchOf([item({ attempts: 8 })]),
      deleteRecording: async () => { throw new VoiceRecordingRequestError("timeout"); },
      failChanges: false,
    });

    await drain.run(erasureId, signal());

    expect(audit.left).not.toHaveBeenCalled();
    expect(errorReporter.report).not.toHaveBeenCalled();
    expect(leftValues(metrics)).toEqual([]);
  });

  it("reports what it gave up on even when its deadline passes mid-run, and leaves the rest to their lease", async () => {
    const deadline = new AbortController();
    const { drain, backlog, errorReporter } = drainHarness({
      claim: batchOf([item({ attempts: 8 }), item({ vendorConversationId: "conv_late" })]),
      deleteRecording: async ({ vendorConversationId: id }) => {
        if (id === vendorConversationId) throw new VoiceRecordingRequestError("timeout");
        // The deadline passes while this ask waits on the vendor, after the other has been settled.
        await new Promise((resolve) => setTimeout(resolve, 5));
        deadline.abort();
        throw new VoiceRecordingRequestError("abandoned");
      },
    });

    await drain.run(erasureId, deadline.signal);

    expect(backlog.fail).toHaveBeenCalledWith(`item-${vendorConversationId}`, "vendor_timeout");
    expect(errorReporter.report).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ reasons: { vendor_timeout: 1 } }) }));
    expect(backlog.release).not.toHaveBeenCalled();
  });

  it("records what the claim gave up on in one write, counts it once, and sends one report and one log line", async () => {
    const givenUp = Array.from({ length: 3 }, (_, index) => givenUpEntry(index === 2 ? "expired" : "credential_missing", index));
    const { drain, source, audit, metrics, logger, errorReporter } = drainHarness({ claim: batchOf([], { sealedCredential: null, givenUp }) });

    await drain.run(erasureId, signal());

    expect(source.deleteRecording).not.toHaveBeenCalled();
    expect(audit.left).toHaveBeenCalledTimes(1);
    expect(audit.left).toHaveBeenCalledWith({
      accountId,
      workspaceId,
      vendor: "elevenlabs",
      recordings: givenUp.map((entry) => ({ conversationId: null, vendorConversationId: entry.vendorConversationId, reason: entry.failureReason })),
    });
    expect(leftValues(metrics)).toEqual([3]);
    expect(errorReporter.report).toHaveBeenCalledTimes(1);
    expect(errorReporter.report).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ leftAtVendor: 3, reasons: { credential_missing: 2, expired: 1 } }) }));
    expect(logger.warn.mock.calls.filter(([, message]) => message === "Voice recording was left at the vendor")).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ erasureId, leftAtVendor: 3, left: { credential_missing: 2, expired: 1 } }),
      "Voice recording erasure left recordings at the vendor",
    );
  });

  it("records the recordings of a vendor this build does not know under that vendor's name, and asks nobody", async () => {
    const { drain, source, audit, metrics } = drainHarness({
      claim: batchOf([], { vendor: "retired-vendor", givenUp: [givenUpEntry("vendor_unsupported", 0)] }),
    });

    await drain.run(erasureId, signal());

    expect(source.deleteRecording).not.toHaveBeenCalled();
    expect(audit.left).toHaveBeenCalledWith(expect.objectContaining({ vendor: "retired-vendor", recordings: [expect.objectContaining({ reason: "vendor_unsupported" })] }));
    expect(counted(metrics, "voice_recording_delete_total")).toEqual([{ vendor: "retired-vendor", outcome: "left_at_vendor" }]);
  });

  it("counts a held key that no longer opens as a refused ask, kept for the next", async () => {
    const { drain, backlog, source } = drainHarness({
      open: () => { throw new Error("Unsupported state or unable to authenticate data"); },
      remaining: { pending: 1, nextAskAt: new Date(Date.now() + 60_000), dueNow: false },
    });

    await drain.run(erasureId, signal());

    expect(source.deleteRecording).not.toHaveBeenCalled();
    expect(backlog.keep).toHaveBeenCalledWith(`item-${vendorConversationId}`, "credential_unreadable", 60);
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
    const { drain, backlog, source } = drainHarness({ claim: { kind: "gone" } });

    await drain.run(erasureId, signal());

    expect(source.deleteRecording).not.toHaveBeenCalled();
    expect(backlog.release).not.toHaveBeenCalled();
  });

  it("gives up, once the job itself kept failing, only on recordings whose eight asks are spent, and reports them", async () => {
    const { drain, backlog, audit, metrics, errorReporter } = drainHarness();
    backlog.failExhausted.mockResolvedValue({
      erasure: { accountId, workspaceId, vendor: "elevenlabs", sealedCredential: null },
      entries: [
        { id: "a", conversationId, vendorConversationId, attempts: 9, failureReason: "vendor_unreachable" },
        { id: "b", conversationId: null, vendorConversationId: "conv_second", attempts: 8, failureReason: "drain_failed" },
      ],
    });
    const transaction = {} as Parameters<VoiceRecordingErasureDrain["giveUp"]>[1];

    await drain.giveUp(erasureId, transaction);

    expect(backlog.failExhausted).toHaveBeenCalledWith(erasureId, 8);
    expect(audit.left).toHaveBeenCalledWith(expect.objectContaining({
      recordings: [
        { conversationId, vendorConversationId, reason: "vendor_unreachable" },
        { conversationId: null, vendorConversationId: "conv_second", reason: "drain_failed" },
      ],
    }));
    expect(errorReporter.report).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ leftAtVendor: 2, reasons: { vendor_unreachable: 1, drain_failed: 1 } }),
    }));
    expect(leftValues(metrics)).toEqual([2]);
  });
});
