import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { VoiceSessionMemory } from "../../src/modules/voiceChannel/services/voiceSessionMemory.js";
import { InMemoryVoiceSessionMemoryStore } from "../support/inMemoryVoiceSessionMemoryStore.js";
import {
  describeVoiceSessionMemoryContract,
  memoryOver,
  TrackingVoiceSessionMemoryStore,
  VOICE_MEMORY_WINDOWS,
} from "../support/voiceSessionMemoryContract.js";

const nextMacrotask = () => new Promise<void>((resolve) => {
  setImmediate(resolve);
});

const newSession = () => ({
  workspaceId: randomUUID(),
  agentId: randomUUID(),
  vendor: "elevenlabs",
  sessionKey: `conv_${randomUUID()}`,
});

describeVoiceSessionMemoryContract("in-memory store", async () => {
  const store = new InMemoryVoiceSessionMemoryStore();
  const tracking = new TrackingVoiceSessionMemoryStore(store);
  return {
    instance: () => memoryOver(tracking, store.notices()),
    session: newSession,
    conversation: async () => randomUUID(),
    async settled() {
      await nextMacrotask();
      await vi.waitFor(() => expect(tracking.pending).toBe(0));
      await nextMacrotask();
    },
    close: async () => undefined,
  };
});

describe("VoiceSessionMemory when notices are missed", () => {
  it("learns from the store, once it listens again, that a newer request overtook one of its requests", async () => {
    const store = new InMemoryVoiceSessionMemoryStore();
    const [connection, other] = [store.notices(), store.notices()];
    const one = memoryOver(store, connection);
    const two = memoryOver(store, other);
    const session = newSession();
    const t0 = Date.now();

    const first = await one.arrive(session, t0);
    await nextMacrotask();
    connection.interrupt();
    await two.arrive(session, t0 + 100);
    await nextMacrotask();
    expect(first.supersededAt).toBeNull();

    connection.resume();
    await vi.waitFor(() => expect(first.supersededAt).toBe(t0 + 100));
  });

  it("retries a catch-up the store failed, while the overtaken request is still in flight", async () => {
    const store = new InMemoryVoiceSessionMemoryStore();
    let failures = 1;
    class FailingOnce extends TrackingVoiceSessionMemoryStore {
      override async supersededAt(sequences: string[]) {
        if (failures > 0) {
          failures -= 1;
          throw new Error("database unavailable");
        }
        return super.supersededAt(sequences);
      }
    }
    const connection = store.notices();
    const logger = { warn: vi.fn() };
    const one = new VoiceSessionMemory({ store: new FailingOnce(store), notices: connection, windows: VOICE_MEMORY_WINDOWS, logger });
    const two = memoryOver(store, store.notices());
    const session = newSession();
    const t0 = Date.now();

    const first = await one.arrive(session, t0);
    await nextMacrotask();
    connection.interrupt();
    await two.arrive(session, t0 + 100);
    connection.resume();

    await vi.waitFor(() => expect(first.supersededAt).toBe(t0 + 100));
    expect(logger.warn).toHaveBeenCalledWith(
      { event: "voice_session_catch_up_failed", errorType: "Error" },
      "Voice session memory degraded",
    );
  });

  it("catches up on a request that arrived while nothing listened", async () => {
    const store = new InMemoryVoiceSessionMemoryStore();
    const connection = store.notices();
    connection.interrupt();
    const one = memoryOver(store, connection);
    const two = memoryOver(store, store.notices());
    const session = newSession();
    const t0 = Date.now();

    const first = await one.arrive(session, t0);
    await two.arrive(session, t0 + 100);
    await nextMacrotask();
    expect(first.supersededAt).toBeNull();

    connection.resume();
    await vi.waitFor(() => expect(first.supersededAt).toBe(t0 + 100));
  });

  it("applies a supersession heard before its own request's number came back", async () => {
    const store = new InMemoryVoiceSessionMemoryStore();
    let releaseArrival!: () => void;
    const held = new Promise<void>((resolve) => { releaseArrival = resolve; });
    let recorded = false;
    // The arrival is recorded at once, but its answer comes back only after the next arrival's notice.
    class SlowAnswers extends TrackingVoiceSessionMemoryStore {
      override async arrive(input: Parameters<TrackingVoiceSessionMemoryStore["arrive"]>[0]) {
        const arrival = await super.arrive(input);
        recorded = true;
        await held;
        return arrival;
      }
    }
    const one = new VoiceSessionMemory({ store: new SlowAnswers(store), notices: store.notices(), windows: VOICE_MEMORY_WINDOWS });
    const two = memoryOver(store, store.notices());
    const session = newSession();
    const t0 = Date.now();

    const arriving = one.arrive(session, t0);
    await vi.waitFor(() => expect(recorded).toBe(true));
    await two.arrive(session, t0 + 100);
    await nextMacrotask();
    releaseArrival();

    expect((await arriving).supersededAt).toBe(t0 + 100);
  });
});
