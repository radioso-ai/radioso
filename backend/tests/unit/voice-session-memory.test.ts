import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { VoiceSessionMemory } from "../../src/modules/voiceChannel/services/voiceSessionMemory.js";
import { InMemoryVoiceSessionMemoryStore } from "../support/inMemoryVoiceSessionMemoryStore.js";
import {
  arrived,
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

interface Deferred {
  promise: Promise<void>;
  release(): void;
}

const deferred = (): Deferred => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

describeVoiceSessionMemoryContract("in-memory store", async () => {
  let offset = 0;
  const now = () => Date.now() + offset;
  const store = new InMemoryVoiceSessionMemoryStore(now);
  const tracking = new TrackingVoiceSessionMemoryStore(store);
  return {
    instance: () => memoryOver(tracking, store.notices()),
    session: newSession,
    conversation: async () => randomUUID(),
    now,
    elapse: async (ms) => {
      offset += ms;
    },
    async settled() {
      await nextMacrotask();
      await vi.waitFor(() => expect(tracking.pending).toBe(0));
      await nextMacrotask();
    },
    close: async () => undefined,
  };
});

describe("VoiceSessionMemory on one instance", () => {
  it("supersedes the request in flight while the store has not yet answered the newer one", async () => {
    const store = new InMemoryVoiceSessionMemoryStore();
    const answer = deferred();
    class SlowArrivals extends TrackingVoiceSessionMemoryStore {
      override async arrive(input: Parameters<TrackingVoiceSessionMemoryStore["arrive"]>[0]) {
        await answer.promise;
        return super.arrive(input);
      }
    }
    const memory = new VoiceSessionMemory({ store: new SlowArrivals(store), notices: store.notices(), windows: VOICE_MEMORY_WINDOWS });
    const session = newSession();

    const first = memory.arrive(session, 1_000);
    const second = memory.arrive(session, 1_100);

    expect(first.supersededAt).toBe(1_100);
    expect(second.supersededAt).toBeNull();
    answer.release();
    await Promise.all([memory.registered(first), memory.registered(second)]);
    expect(first.supersededAt).toBe(1_100);
    expect(second.supersededAt).toBeNull();
  });

  it("registers a request without waiting for writes made off an earlier turn's path", async () => {
    const store = new InMemoryVoiceSessionMemoryStore();
    const background = deferred();
    class SlowBackgroundWrites extends TrackingVoiceSessionMemoryStore {
      override async settle(input: Parameters<TrackingVoiceSessionMemoryStore["settle"]>[0]) {
        await background.promise;
        return super.settle(input);
      }

      override async claimBridge(input: Parameters<TrackingVoiceSessionMemoryStore["claimBridge"]>[0]) {
        await background.promise;
        return super.claimBridge(input);
      }

      override async claimInterruptionNote(input: Parameters<TrackingVoiceSessionMemoryStore["claimInterruptionNote"]>[0]) {
        await background.promise;
        return super.claimInterruptionNote(input);
      }
    }
    const memory = new VoiceSessionMemory({ store: new SlowBackgroundWrites(store), notices: store.notices(), windows: VOICE_MEMORY_WINDOWS });
    const session = newSession();

    const first = await arrived(memory, session, 1_000);
    const bridge = memory.claimBridge(first);
    first.outcomeAt = 1_200;
    const settled = memory.settle(first, 1_200, {
      utterance: "When do you open?",
      conversationId: randomUUID(),
      reply: { messageId: randomUUID(), text: "At nine." },
      spoken: { bridge: null, reply: "At nine." },
      cutOffAt: null,
    });
    const second = memory.arrive(session, 1_300);
    const note = memory.reserveInterruption(second, "At");

    const registeredFirst = await Promise.race([memory.registered(second).then(() => "registered"), nextMacrotask().then(() => "waiting")]);
    expect(registeredFirst).toBe("registered");

    background.release();
    await Promise.all([bridge, settled, note]);
  });

  it("hears the next request of the session the moment its turn settles, before the store has the settle", async () => {
    const store = new InMemoryVoiceSessionMemoryStore();
    const background = deferred();
    class SlowSettles extends TrackingVoiceSessionMemoryStore {
      override async settle(input: Parameters<TrackingVoiceSessionMemoryStore["settle"]>[0]) {
        await background.promise;
        return super.settle(input);
      }
    }
    const memory = new VoiceSessionMemory({ store: new SlowSettles(store), notices: store.notices(), windows: VOICE_MEMORY_WINDOWS });
    const session = newSession();
    const reply = { messageId: randomUUID(), text: "We open at nine." };

    const first = await arrived(memory, session, 1_000);
    first.hungUpAt = 1_100;
    const settled = memory.settle(first, 1_200, {
      utterance: "When do you open?",
      conversationId: randomUUID(),
      reply,
      spoken: { bridge: null, reply: reply.text },
      cutOffAt: 1_100,
    });
    const again = await arrived(memory, session, 1_300);

    expect(memory.replayFor(again, "When do you open?", 1_300)?.reply).toEqual(reply);
    background.release();
    await settled;
  });
});

describe("VoiceSessionMemory when notices are missed", () => {
  it("learns from the store, once it listens again, that a newer request overtook one of its requests", async () => {
    const store = new InMemoryVoiceSessionMemoryStore();
    const [connection, other] = [store.notices(), store.notices()];
    const one = memoryOver(store, connection);
    const two = memoryOver(store, other);
    const session = newSession();

    const first = await arrived(one, session, Date.now());
    await nextMacrotask();
    connection.interrupt();
    const before = Date.now();
    await arrived(two, session, before);
    await nextMacrotask();
    expect(first.supersededAt).toBeNull();

    connection.resume();
    await vi.waitFor(() => expect(first.supersededAt).not.toBeNull());
    expect(first.supersededAt).toBeGreaterThanOrEqual(before);
  });

  it("retries a catch-up the store failed, while the overtaken request is still in flight", async () => {
    const store = new InMemoryVoiceSessionMemoryStore();
    let failures = 1;
    class FailingOnce extends TrackingVoiceSessionMemoryStore {
      override async supersededAt(requests: Parameters<TrackingVoiceSessionMemoryStore["supersededAt"]>[0]) {
        if (failures > 0) {
          failures -= 1;
          throw new Error("database unavailable");
        }
        return super.supersededAt(requests);
      }
    }
    const connection = store.notices();
    const logger = { warn: vi.fn() };
    const one = new VoiceSessionMemory({ store: new FailingOnce(store), notices: connection, windows: VOICE_MEMORY_WINDOWS, logger });
    const two = memoryOver(store, store.notices());
    const session = newSession();

    const first = await arrived(one, session, Date.now());
    await nextMacrotask();
    connection.interrupt();
    await arrived(two, session, Date.now());
    connection.resume();

    await vi.waitFor(() => expect(first.supersededAt).not.toBeNull());
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

    const first = await arrived(one, session, Date.now());
    await arrived(two, session, Date.now());
    await nextMacrotask();
    expect(first.supersededAt).toBeNull();

    connection.resume();
    await vi.waitFor(() => expect(first.supersededAt).not.toBeNull());
  });

  it("applies a supersession heard before its own request's number came back", async () => {
    const store = new InMemoryVoiceSessionMemoryStore();
    const answer = deferred();
    let recorded = false;
    // The arrival is recorded at once, but its answer comes back only after the next arrival's notice.
    class SlowAnswers extends TrackingVoiceSessionMemoryStore {
      override async arrive(input: Parameters<TrackingVoiceSessionMemoryStore["arrive"]>[0]) {
        const arrival = await super.arrive(input);
        recorded = true;
        await answer.promise;
        return arrival;
      }
    }
    const one = new VoiceSessionMemory({ store: new SlowAnswers(store), notices: store.notices(), windows: VOICE_MEMORY_WINDOWS });
    const two = memoryOver(store, store.notices());
    const session = newSession();

    const first = one.arrive(session, Date.now());
    await vi.waitFor(() => expect(recorded).toBe(true));
    await arrived(two, session, Date.now());
    await nextMacrotask();
    answer.release();
    await one.registered(first);

    expect(first.supersededAt).not.toBeNull();
  });
});
