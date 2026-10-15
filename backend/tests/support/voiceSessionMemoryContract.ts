import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VoiceSessionRef } from "../../src/modules/voiceChannel/domain.js";
import {
  cutOffAt,
  VoiceSessionMemory,
  type VoiceExchange,
  type VoiceSessionMemoryStore,
  type VoiceSessionNoticeSource,
  type VoiceTurnClaim,
} from "../../src/modules/voiceChannel/services/voiceSessionMemory.js";

export const VOICE_MEMORY_WINDOWS = { replayWindowMs: 30_000, bridgeAfterMs: 2_500 };

/** Counts the store calls still running, so a test knows every write made off a turn's path landed. */
export class TrackingVoiceSessionMemoryStore implements VoiceSessionMemoryStore {
  private running = 0;

  constructor(private readonly inner: VoiceSessionMemoryStore) {}

  get pending(): number {
    return this.running;
  }

  arrive(input: Parameters<VoiceSessionMemoryStore["arrive"]>[0]) {
    return this.track(() => this.inner.arrive(input));
  }

  settle(input: Parameters<VoiceSessionMemoryStore["settle"]>[0]) {
    return this.track(() => this.inner.settle(input));
  }

  bridgeSpoken(input: Parameters<VoiceSessionMemoryStore["bridgeSpoken"]>[0]) {
    return this.track(() => this.inner.bridgeSpoken(input));
  }

  claimInterruptionNote(input: Parameters<VoiceSessionMemoryStore["claimInterruptionNote"]>[0]) {
    return this.track(() => this.inner.claimInterruptionNote(input));
  }

  releaseInterruptionNote(input: Parameters<VoiceSessionMemoryStore["releaseInterruptionNote"]>[0]) {
    return this.track(() => this.inner.releaseInterruptionNote(input));
  }

  supersededAt(sequences: string[]) {
    return this.track(() => this.inner.supersededAt(sequences));
  }

  private async track<T>(call: () => Promise<T>): Promise<T> {
    this.running += 1;
    try {
      return await call();
    } finally {
      this.running -= 1;
    }
  }
}

/** One instance's memory over the harness's shared store. */
export const memoryOver = (store: VoiceSessionMemoryStore, notices: VoiceSessionNoticeSource) =>
  new VoiceSessionMemory({ store, notices, windows: VOICE_MEMORY_WINDOWS });

export interface VoiceSessionMemoryHarness {
  /** A memory as one backend instance holds it; every instance of a harness shares one store. */
  instance(): VoiceSessionMemory;
  /** A session no test has used. */
  session(): VoiceSessionRef;
  /** A conversation the session's exchanges are kept in. */
  conversation(session: VoiceSessionRef): Promise<string>;
  /** Every write an instance made off a turn's path has landed. */
  settled(): Promise<void>;
  close(): Promise<void>;
}

const reply = "We open at nine. See you then!";

/** What a request's turn left in the conversation: a stored answer, spoken whole unless cut off. */
const exchangeOf = (
  claim: VoiceTurnClaim,
  conversationId: string,
  overrides: Partial<VoiceExchange> = {},
): VoiceExchange => ({
  utterance: "When do you open?",
  conversationId,
  reply: { messageId: randomUUID(), text: reply },
  spoken: { bridge: null, reply },
  cutOffAt: cutOffAt(claim),
  ...overrides,
});

/**
 * The behaviour every `VoiceSessionMemory` keeps whatever its store, and whichever instance each
 * request of a session lands on: two instances of a harness share one store.
 */
export const describeVoiceSessionMemoryContract = (
  name: string,
  createHarness: () => Promise<VoiceSessionMemoryHarness>,
): void => {
  describe(`${name}: voice session memory`, () => {
    let harness: VoiceSessionMemoryHarness;
    let t0: number;

    beforeEach(async () => {
      harness = await createHarness();
      t0 = Date.now();
    });

    afterEach(async () => {
      await harness.close();
    });

    /** A turn whose caller the runtime hung up on, which still stored its answer. */
    const hungUpAnswer = async (memory: VoiceSessionMemory, session: VoiceSessionRef, at: number) => {
      const conversationId = await harness.conversation(session);
      const claim = await memory.arrive(session, at);
      claim.hungUpAt = at + 1_000;
      claim.outcomeAt = at + 3_000;
      const exchange = exchangeOf(claim, conversationId);
      memory.settle(claim, at + 3_000, exchange);
      await harness.settled();
      return exchange;
    };

    /** A turn whose answer reached the runtime whole. */
    const deliveredAnswer = async (memory: VoiceSessionMemory, session: VoiceSessionRef, at: number) => {
      const conversationId = await harness.conversation(session);
      const claim = await memory.arrive(session, at);
      claim.outcomeAt = at + 2_000;
      memory.settle(claim, at + 2_000, exchangeOf(claim, conversationId));
      await harness.settled();
    };

    describe("the newest request", () => {
      it("supersedes the request in flight before it, as of its own arrival", async () => {
        const memory = harness.instance();
        const session = harness.session();

        const first = await memory.arrive(session, t0);
        const second = await memory.arrive(session, t0 + 100);

        expect(first.supersededAt).toBe(t0 + 100);
        expect(second.supersededAt).toBeNull();
        expect(BigInt(second.sequence)).toBeGreaterThan(BigInt(first.sequence));
      });

      it("leaves a request that settled before it arrived alone", async () => {
        const memory = harness.instance();
        const session = harness.session();

        const first = await memory.arrive(session, t0);
        memory.settle(first, t0 + 50, undefined);
        await harness.settled();
        await memory.arrive(session, t0 + 100);

        expect(first.supersededAt).toBeNull();
      });

      it("supersedes a request in flight on another instance", async () => {
        const [one, two] = [harness.instance(), harness.instance()];
        const session = harness.session();

        const first = await one.arrive(session, t0);
        const second = await two.arrive(session, t0 + 100);

        await vi.waitFor(() => expect(first.supersededAt).toBe(t0 + 100));
        expect(second.supersededAt).toBeNull();
        expect(BigInt(second.sequence)).toBeGreaterThan(BigInt(first.sequence));
      });

      it("orders a session's requests by arrival whichever instance takes each one", async () => {
        const [one, two] = [harness.instance(), harness.instance()];
        const session = harness.session();

        const first = await one.arrive(session, t0);
        const second = await two.arrive(session, t0 + 100);
        const third = await one.arrive(session, t0 + 200);

        await vi.waitFor(() => {
          expect(first.supersededAt).toBe(t0 + 100);
          expect(second.supersededAt).toBe(t0 + 200);
        });
        expect(third.supersededAt).toBeNull();
        expect([first, second, third].map((claim) => BigInt(claim.sequence))).toEqual(
          [first, second, third].map((claim) => BigInt(claim.sequence)).sort((left, right) => (left < right ? -1 : 1)),
        );
      });

      it("keeps sessions apart", async () => {
        const memory = harness.instance();
        const [session, other] = [harness.session(), harness.session()];

        const first = await memory.arrive(session, t0);
        await memory.arrive(other, t0 + 100);
        await harness.settled();

        expect(first.supersededAt).toBeNull();
      });
    });

    describe("bridge lines", () => {
      it("lets no superseded request bridge", async () => {
        const memory = harness.instance();
        const session = harness.session();

        const first = await memory.arrive(session, t0);
        await memory.arrive(session, t0 + 100);

        expect(memory.mayBridge(first, t0 + 200)).toBe(false);
      });

      it("lets a request bridge again after its own bridge line", async () => {
        const memory = harness.instance();
        const session = harness.session();

        const claim = await memory.arrive(session, t0);
        memory.bridgeSpoken(claim, t0 + 50);

        expect(memory.mayBridge(claim, t0 + 100)).toBe(true);
      });

      it("holds a bridge back while a bridge from an overtaken request on another instance is fresher than the delay", async () => {
        const [one, two] = [harness.instance(), harness.instance()];
        const session = harness.session();

        const first = await one.arrive(session, t0);
        one.bridgeSpoken(first, t0 + 50);
        await harness.settled();
        const second = await two.arrive(session, t0 + 600);

        await vi.waitFor(() => expect(one.mayBridge(first, t0 + 700)).toBe(false));
        expect(two.mayBridge(second, t0 + 700)).toBe(false);
        expect(two.mayBridge(second, t0 + 50 + 2_499)).toBe(false);
        expect(two.mayBridge(second, t0 + 50 + 2_500)).toBe(true);
      });

      it("holds a bridge back after the bridge of a request the runtime hung up on", async () => {
        const [one, two] = [harness.instance(), harness.instance()];
        const session = harness.session();

        const first = await one.arrive(session, t0);
        one.bridgeSpoken(first, t0 + 50);
        first.hungUpAt = t0 + 80;
        first.outcomeAt = t0 + 90;
        one.settle(first, t0 + 90, undefined);
        await harness.settled();
        const second = await two.arrive(session, t0 + 200);

        expect(two.mayBridge(second, t0 + 300)).toBe(false);
      });

      it("lets the next request bridge after a bridge whose request delivered its outcome", async () => {
        const [one, two] = [harness.instance(), harness.instance()];
        const session = harness.session();

        const first = await one.arrive(session, t0);
        one.bridgeSpoken(first, t0 + 50);
        first.outcomeAt = t0 + 100;
        one.settle(first, t0 + 100, undefined);
        await harness.settled();
        const second = await two.arrive(session, t0 + 200);

        expect(two.mayBridge(second, t0 + 300)).toBe(true);
      });

      it("knows exactly whether a request on the same instance lost its caller", async () => {
        const memory = harness.instance();
        const session = harness.session();

        // The first request delivered its fallback outcome and still drains its reply when the next one arrives.
        const first = await memory.arrive(session, t0);
        memory.bridgeSpoken(first, t0 + 50);
        first.outcomeAt = t0 + 100;
        const second = await memory.arrive(session, t0 + 200);

        expect(first.supersededAt).toBe(t0 + 200);
        expect(memory.mayBridge(second, t0 + 300)).toBe(true);
      });
    });

    describe("an identical re-request", () => {
      it("hears the stored answer the runtime hung up on, from another instance, whitespace aside", async () => {
        const [one, two] = [harness.instance(), harness.instance()];
        const session = harness.session();
        const exchange = await hungUpAnswer(one, session, t0);

        const again = await two.arrive(session, t0 + 4_000);

        expect(two.replayFor(again, "  When do you\nopen? ", t0 + 4_000)).toEqual({
          conversationId: exchange.conversationId,
          reply: exchange.reply,
        });
      });

      it("hears the stored answer of a request a newer one overtook before its outcome", async () => {
        const [one, two] = [harness.instance(), harness.instance()];
        const session = harness.session();
        const conversationId = await harness.conversation(session);

        const first = await one.arrive(session, t0);
        const second = await two.arrive(session, t0 + 1_000);
        await vi.waitFor(() => expect(first.supersededAt).toBe(t0 + 1_000));
        first.outcomeAt = t0 + 1_500;
        const exchange = exchangeOf(first, conversationId);
        one.settle(first, t0 + 1_500, exchange);
        two.settle(second, t0 + 1_600, undefined);
        await harness.settled();
        const again = await one.arrive(session, t0 + 2_000);

        expect(exchange.cutOffAt).toBe(t0 + 1_000);
        expect(one.replayFor(again, "When do you open?", t0 + 2_000)?.reply).toEqual(exchange.reply);
      });

      it("runs a new turn when the answer reached the runtime", async () => {
        const memory = harness.instance();
        const session = harness.session();
        await deliveredAnswer(memory, session, t0);

        const again = await memory.arrive(session, t0 + 4_000);

        expect(memory.replayFor(again, "When do you open?", t0 + 4_000)).toBeNull();
      });

      it("runs a new turn once the replay window has passed", async () => {
        const memory = harness.instance();
        const session = harness.session();
        await hungUpAnswer(memory, session, t0);

        // The runtime hung up a second in; the window runs from there.
        const within = await memory.arrive(session, t0 + 1_000 + 30_000);
        expect(memory.replayFor(within, "When do you open?", t0 + 1_000 + 30_000)).not.toBeNull();
        memory.settle(within, t0 + 1_000 + 30_000, undefined);
        await harness.settled();
        const late = await memory.arrive(session, t0 + 1_000 + 30_001);
        expect(memory.replayFor(late, "When do you open?", t0 + 1_000 + 30_001)).toBeNull();
      });

      it("runs a new turn for a different utterance", async () => {
        const memory = harness.instance();
        const session = harness.session();
        await hungUpAnswer(memory, session, t0);

        const other = await memory.arrive(session, t0 + 4_000);

        expect(memory.replayFor(other, "When do you close?", t0 + 4_000)).toBeNull();
      });

      it("runs a new turn while another request's chat turn runs on this instance", async () => {
        const memory = harness.instance();
        const session = harness.session();
        await hungUpAnswer(memory, session, t0);

        const running = await memory.arrive(session, t0 + 4_000);
        memory.chatTurnStarted(running);
        const again = await memory.arrive(session, t0 + 4_100);
        expect(memory.replayFor(again, "When do you open?", t0 + 4_100)).toBeNull();

        memory.chatTurnEnded(running);
        memory.settle(running, t0 + 4_200, undefined);
        memory.settle(again, t0 + 4_200, undefined);
        await harness.settled();
        const later = await memory.arrive(session, t0 + 4_300);
        expect(memory.replayFor(later, "When do you open?", t0 + 4_300)).not.toBeNull();
      });

      it("hears the answer while a request on this instance is still setting up, which the re-request supersedes", async () => {
        const memory = harness.instance();
        const session = harness.session();
        await hungUpAnswer(memory, session, t0);

        const settingUp = await memory.arrive(session, t0 + 4_000);
        const again = await memory.arrive(session, t0 + 4_100);

        expect(memory.replayFor(again, "When do you open?", t0 + 4_100)).not.toBeNull();
        expect(settingUp.supersededAt).toBe(t0 + 4_100);
      });

      it("runs a new turn while a request of the session is in flight on another instance", async () => {
        const [one, two] = [harness.instance(), harness.instance()];
        const session = harness.session();
        await hungUpAnswer(one, session, t0);

        await two.arrive(session, t0 + 4_000);
        const again = await one.arrive(session, t0 + 4_100);

        expect(one.replayFor(again, "When do you open?", t0 + 4_100)).toBeNull();
      });

      it("keeps the newer request's exchange when an older request settles after it", async () => {
        const [one, two] = [harness.instance(), harness.instance()];
        const session = harness.session();
        const conversationId = await harness.conversation(session);

        const older = await one.arrive(session, t0);
        const newer = await two.arrive(session, t0 + 100);
        newer.hungUpAt = t0 + 200;
        two.settle(newer, t0 + 300, exchangeOf(newer, conversationId, { utterance: "And on Sundays?" }));
        await harness.settled();
        older.outcomeAt = t0 + 400;
        await vi.waitFor(() => expect(older.supersededAt).toBe(t0 + 100));
        one.settle(older, t0 + 400, exchangeOf(older, conversationId));
        await harness.settled();
        const again = await one.arrive(session, t0 + 500);

        expect(one.replayFor(again, "And on Sundays?", t0 + 500)).not.toBeNull();
        expect(one.replayFor(again, "When do you open?", t0 + 500)).toBeNull();
      });
    });

    describe("a reply the caller interrupted", () => {
      const heardUntil = "We open at nine.  ​See";

      it("is reserved once, whichever instances the reports land on", async () => {
        const [one, two] = [harness.instance(), harness.instance()];
        const session = harness.session();
        await deliveredAnswer(one, session, t0);

        const [left, right] = [await one.arrive(session, t0 + 3_000), await two.arrive(session, t0 + 3_100)];
        const reservations = await Promise.all([
          one.reserveInterruption(left, heardUntil),
          two.reserveInterruption(right, heardUntil),
        ]);
        const taken = reservations.filter((reservation) => reservation !== null);

        expect(taken).toHaveLength(1);
        expect(taken[0]?.interruption).toEqual(expect.objectContaining({ heardCharacterCount: 20, spokenCharacterCount: 30 }));
        taken[0]?.recorded();
        await harness.settled();
        const later = await two.arrive(session, t0 + 3_200);
        await expect(two.reserveInterruption(later, heardUntil)).resolves.toBeNull();
      });

      it("is handed back to the next report when its note could not be recorded", async () => {
        const [one, two] = [harness.instance(), harness.instance()];
        const session = harness.session();
        await deliveredAnswer(one, session, t0);

        const first = await one.arrive(session, t0 + 3_000);
        const reservation = await one.reserveInterruption(first, heardUntil);
        expect(reservation).not.toBeNull();
        reservation?.failed();
        await harness.settled();
        const next = await two.arrive(session, t0 + 3_100);

        await expect(two.reserveInterruption(next, heardUntil)).resolves.not.toBeNull();
      });

      it("is not reserved when the report is no strict prefix of what was spoken", async () => {
        const memory = harness.instance();
        const session = harness.session();
        await deliveredAnswer(memory, session, t0);

        const next = await memory.arrive(session, t0 + 3_000);

        await expect(memory.reserveInterruption(next, "We close at")).resolves.toBeNull();
      });
    });

    describe("idle forgetting", () => {
      const heardUntil = "We open at nine.  ​See";

      it("forgets a session idle for longer than the replay window with nothing in flight", async () => {
        const memory = harness.instance();
        const [kept, forgotten] = [harness.session(), harness.session()];
        await deliveredAnswer(memory, kept, t0);
        await deliveredAnswer(memory, forgotten, t0);

        // Both answers settled at t0 + 2 s.
        const soon = await memory.arrive(kept, t0 + 2_000 + 30_000);
        const late = await memory.arrive(forgotten, t0 + 2_000 + 30_001);

        await expect(memory.reserveInterruption(soon, heardUntil)).resolves.not.toBeNull();
        await expect(memory.reserveInterruption(late, heardUntil)).resolves.toBeNull();
      });

      it("remembers a session while one of its requests is in flight, however long it runs", async () => {
        const memory = harness.instance();
        const session = harness.session();
        await deliveredAnswer(memory, session, t0);

        await memory.arrive(session, t0 + 3_000);
        const next = await memory.arrive(session, t0 + 3_000 + 60_000);

        await expect(memory.reserveInterruption(next, heardUntil)).resolves.not.toBeNull();
      });

      it("stops counting a request in flight once it is older than a request lives, as when its instance crashed", async () => {
        const [crashed, alive] = [harness.instance(), harness.instance()];
        const session = harness.session();
        await deliveredAnswer(alive, session, t0);

        // Never settled: the instance that took it is gone.
        await crashed.arrive(session, t0 + 3_000);
        const next = await alive.arrive(session, t0 + 3_000 + 5 * 60_000 + 1);

        await expect(alive.reserveInterruption(next, heardUntil)).resolves.toBeNull();
      });
    });
  });
};
