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

  claimBridge(input: Parameters<VoiceSessionMemoryStore["claimBridge"]>[0]) {
    return this.track(() => this.inner.claimBridge(input));
  }

  claimInterruptionNote(input: Parameters<VoiceSessionMemoryStore["claimInterruptionNote"]>[0]) {
    return this.track(() => this.inner.claimInterruptionNote(input));
  }

  releaseInterruptionNote(input: Parameters<VoiceSessionMemoryStore["releaseInterruptionNote"]>[0]) {
    return this.track(() => this.inner.releaseInterruptionNote(input));
  }

  supersededAt(requests: Parameters<VoiceSessionMemoryStore["supersededAt"]>[0]) {
    return this.track(() => this.inner.supersededAt(requests));
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

/** A request that arrived and is registered in the store. */
export const arrived = async (memory: VoiceSessionMemory, session: VoiceSessionRef, now: number): Promise<VoiceTurnClaim> => {
  const claim = memory.arrive(session, now);
  await memory.registered(claim);
  return claim;
};

export interface VoiceSessionMemoryHarness {
  /** A memory as one backend instance holds it; every instance of a harness shares one store. */
  instance(): VoiceSessionMemory;
  /** A session no test has used. */
  session(): VoiceSessionRef;
  /** A conversation the session's exchanges are kept in. */
  conversation(session: VoiceSessionRef): Promise<string>;
  /** The clock the instances and the store share. */
  now(): number;
  /** Time passes for the instances and the store alike. */
  elapse(ms: number): Promise<void>;
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

/** A store's clock and this process's may read a few milliseconds apart. */
const CLOCK_SLACK_MS = 50;

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

    beforeEach(async () => {
      harness = await createHarness();
    });

    afterEach(async () => {
      await harness.close();
    });

    /** A turn whose caller the runtime hung up on, which still stored its answer. */
    const hungUpAnswer = async (memory: VoiceSessionMemory, session: VoiceSessionRef) => {
      const conversationId = await harness.conversation(session);
      const at = harness.now();
      const claim = await arrived(memory, session, at);
      claim.hungUpAt = at + 1;
      claim.outcomeAt = at + 2;
      const exchange = exchangeOf(claim, conversationId);
      await memory.settle(claim, at + 2, exchange);
      return exchange;
    };

    /** A turn whose answer reached the runtime whole. */
    const deliveredAnswer = async (memory: VoiceSessionMemory, session: VoiceSessionRef) => {
      const conversationId = await harness.conversation(session);
      const at = harness.now();
      const claim = await arrived(memory, session, at);
      claim.outcomeAt = at + 1;
      await memory.settle(claim, at + 1, exchangeOf(claim, conversationId));
    };

    /** The other instance learned, within the time its store took to register the newer request. */
    const expectSupersededAround = async (claim: VoiceTurnClaim, from: number, to: () => number) => {
      await vi.waitFor(() => expect(claim.supersededAt).not.toBeNull());
      expect(claim.supersededAt).toBeGreaterThanOrEqual(from - CLOCK_SLACK_MS);
      expect(claim.supersededAt).toBeLessThanOrEqual(to() + CLOCK_SLACK_MS);
    };

    describe("the newest request", () => {
      it("supersedes the request in flight on this instance as it arrives, before the store has it", async () => {
        const memory = harness.instance();
        const session = harness.session();
        const t = harness.now();

        const first = await arrived(memory, session, t);
        const second = memory.arrive(session, t + 100);

        expect(first.supersededAt).toBe(t + 100);
        await memory.registered(second);
        expect(second.supersededAt).toBeNull();
      });

      it("leaves a request that settled before it arrived alone", async () => {
        const memory = harness.instance();
        const session = harness.session();
        const t = harness.now();

        const first = await arrived(memory, session, t);
        await memory.settle(first, t + 50, undefined);
        await arrived(memory, session, t + 100);

        expect(first.supersededAt).toBeNull();
      });

      it("supersedes a request in flight on another instance", async () => {
        const [one, two] = [harness.instance(), harness.instance()];
        const session = harness.session();

        const first = await arrived(one, session, harness.now());
        const before = harness.now();
        const second = await arrived(two, session, before);

        await expectSupersededAround(first, before, () => harness.now());
        expect(second.supersededAt).toBeNull();
      });

      it("orders a session's requests by arrival whichever instance takes each one", async () => {
        const [one, two] = [harness.instance(), harness.instance()];
        const session = harness.session();

        const first = await arrived(one, session, harness.now());
        const second = await arrived(two, session, harness.now());
        const third = await arrived(one, session, harness.now());

        // `first` may hear of `second` through its notice or be marked by `third` on its own
        // instance, whichever comes first; the two clocks are not compared.
        await vi.waitFor(() => {
          expect(first.supersededAt).not.toBeNull();
          expect(second.supersededAt).not.toBeNull();
        });
        expect(third.supersededAt).toBeNull();
      });

      it("keeps sessions apart", async () => {
        const memory = harness.instance();
        const [session, other] = [harness.session(), harness.session()];
        const t = harness.now();

        const first = await arrived(memory, session, t);
        await arrived(memory, other, t + 100);
        await harness.settled();

        expect(first.supersededAt).toBeNull();
      });
    });

    describe("bridge lines", () => {
      it("lets no superseded request bridge", async () => {
        const memory = harness.instance();
        const session = harness.session();
        const t = harness.now();

        const first = await arrived(memory, session, t);
        await arrived(memory, session, t + 100);

        expect(memory.mayBridge(first, t + 200)).toBe(false);
      });

      it("lets a request bridge again after its own bridge line", async () => {
        const memory = harness.instance();
        const session = harness.session();
        const t = harness.now();

        const claim = await arrived(memory, session, t);
        await expect(memory.claimBridge(claim)).resolves.toBe(true);
        memory.bridgeSpoken(claim, t + 50);

        expect(memory.mayBridge(claim, t + 100)).toBe(true);
      });

      it("holds a bridge back while a bridge from an overtaken request on another instance is fresher than the delay", async () => {
        const [one, two] = [harness.instance(), harness.instance()];
        const session = harness.session();
        const t = harness.now();

        const first = await arrived(one, session, t);
        await expect(one.claimBridge(first)).resolves.toBe(true);
        one.bridgeSpoken(first, t);
        const second = await arrived(two, session, t + 600);

        await vi.waitFor(() => expect(one.mayBridge(first, t + 700)).toBe(false));
        expect(two.mayBridge(second, t + 700)).toBe(false);
        expect(two.mayBridge(second, t + 2_000)).toBe(false);
        expect(two.mayBridge(second, t + 2_500 + 2 * CLOCK_SLACK_MS)).toBe(true);
      });

      it("holds a bridge back after the bridge of a request the runtime hung up on, on another instance", async () => {
        const [one, two] = [harness.instance(), harness.instance()];
        const session = harness.session();
        const t = harness.now();

        const first = await arrived(one, session, t);
        await one.claimBridge(first);
        one.bridgeSpoken(first, t);
        first.hungUpAt = t + 80;
        first.outcomeAt = t + 90;
        await one.settle(first, t + 90, undefined);
        const second = await arrived(two, session, t + 200);

        expect(two.mayBridge(second, t + 300)).toBe(false);
      });

      it("lets the next request bridge after a bridge whose request delivered its outcome", async () => {
        const [one, two] = [harness.instance(), harness.instance()];
        const session = harness.session();
        const t = harness.now();

        const first = await arrived(one, session, t);
        await one.claimBridge(first);
        one.bridgeSpoken(first, t);
        first.outcomeAt = t + 100;
        await one.settle(first, t + 100, undefined);
        const second = await arrived(two, session, t + 200);

        expect(two.mayBridge(second, t + 300)).toBe(true);
      });

      it("knows exactly whether a request on the same instance lost its caller", async () => {
        const memory = harness.instance();
        const session = harness.session();
        const t = harness.now();

        // The first request delivered its fallback outcome and still drains its reply when the next one arrives.
        const first = await arrived(memory, session, t);
        await memory.claimBridge(first);
        memory.bridgeSpoken(first, t + 50);
        first.outcomeAt = t + 100;
        const second = await arrived(memory, session, t + 200);

        expect(first.supersededAt).toBe(t + 200);
        expect(memory.mayBridge(second, t + 300)).toBe(true);
      });

      it("refuses the bridge of a request another instance overtook, before its own instance hears of it", async () => {
        const [one, two] = [harness.instance(), harness.instance()];
        const session = harness.session();
        const t = harness.now();

        const first = await arrived(one, session, t);
        const second = await arrived(two, session, t + 100);

        await expect(one.claimBridge(first)).resolves.toBe(false);
        await expect(two.claimBridge(second)).resolves.toBe(true);
      });

      it("lets a request speak the bridge it was allowed before a newer request of its own instance arrived", async () => {
        const memory = harness.instance();
        const session = harness.session();
        const t = harness.now();

        const first = await arrived(memory, session, t);
        expect(memory.mayBridge(first, t + 50)).toBe(true);
        await arrived(memory, session, t + 60);

        await expect(memory.claimBridge(first)).resolves.toBe(true);
      });
    });

    describe("an identical re-request", () => {
      it("hears the stored answer the runtime hung up on, from another instance, whitespace aside", async () => {
        const [one, two] = [harness.instance(), harness.instance()];
        const session = harness.session();
        const exchange = await hungUpAnswer(one, session);
        const t = harness.now();

        const again = await arrived(two, session, t);

        expect(two.replayFor(again, "  When do you\nopen? ", t)).toEqual({
          conversationId: exchange.conversationId,
          reply: exchange.reply,
        });
      });

      it("hears the stored answer of a request a newer one on another instance overtook before its outcome", async () => {
        const [one, two] = [harness.instance(), harness.instance()];
        const session = harness.session();
        const conversationId = await harness.conversation(session);

        const first = await arrived(one, session, harness.now());
        const second = await arrived(two, session, harness.now());
        await vi.waitFor(() => expect(first.supersededAt).not.toBeNull());
        first.outcomeAt = harness.now() + 1_000;
        const exchange = exchangeOf(first, conversationId);
        await one.settle(first, harness.now(), exchange);
        await two.settle(second, harness.now(), undefined);
        const t = harness.now();
        const again = await arrived(one, session, t);

        expect(exchange.cutOffAt).toBe(first.supersededAt);
        expect(one.replayFor(again, "When do you open?", t)?.reply).toEqual(exchange.reply);
      });

      it("runs a new turn when the answer reached the runtime", async () => {
        const memory = harness.instance();
        const session = harness.session();
        await deliveredAnswer(memory, session);
        const t = harness.now();

        const again = await arrived(memory, session, t);

        expect(memory.replayFor(again, "When do you open?", t)).toBeNull();
      });

      it("runs a new turn once the replay window has passed", async () => {
        const memory = harness.instance();
        const session = harness.session();
        const exchange = await hungUpAnswer(memory, session);
        const cutOff = exchange.cutOffAt!;

        const within = await arrived(memory, session, cutOff + 30_000);
        expect(memory.replayFor(within, "When do you open?", cutOff + 30_000)).not.toBeNull();
        await memory.settle(within, cutOff + 30_000, undefined);
        const late = await arrived(memory, session, cutOff + 30_001);
        expect(memory.replayFor(late, "When do you open?", cutOff + 30_001)).toBeNull();
      });

      it("runs a new turn for a different utterance", async () => {
        const memory = harness.instance();
        const session = harness.session();
        await hungUpAnswer(memory, session);
        const t = harness.now();

        const other = await arrived(memory, session, t);

        expect(memory.replayFor(other, "When do you close?", t)).toBeNull();
      });

      it("runs a new turn while another request's chat turn runs on this instance", async () => {
        const memory = harness.instance();
        const session = harness.session();
        await hungUpAnswer(memory, session);
        const t = harness.now();

        const running = await arrived(memory, session, t);
        memory.chatTurnStarted(running, t);
        const again = await arrived(memory, session, t + 100);
        expect(memory.replayFor(again, "When do you open?", t + 100)).toBeNull();

        memory.chatTurnEnded(running, t + 200);
        await memory.settle(running, t + 200, undefined);
        await memory.settle(again, t + 200, undefined);
        const later = await arrived(memory, session, t + 300);
        expect(memory.replayFor(later, "When do you open?", t + 300)).not.toBeNull();
      });

      it("hears the answer while a request on this instance is still setting up, which the re-request supersedes", async () => {
        const memory = harness.instance();
        const session = harness.session();
        await hungUpAnswer(memory, session);
        const t = harness.now();

        const settingUp = await arrived(memory, session, t);
        const again = await arrived(memory, session, t + 100);

        expect(memory.replayFor(again, "When do you open?", t + 100)).not.toBeNull();
        expect(settingUp.supersededAt).toBe(t + 100);
      });

      it("runs a new turn while a request of the session is in flight on another instance", async () => {
        const [one, two] = [harness.instance(), harness.instance()];
        const session = harness.session();
        await hungUpAnswer(one, session);
        const t = harness.now();

        await arrived(two, session, t);
        const again = await arrived(one, session, t + 100);

        expect(one.replayFor(again, "When do you open?", t + 100)).toBeNull();
      });

      it("keeps the newer request's exchange when an older request settles after it", async () => {
        const [one, two] = [harness.instance(), harness.instance()];
        const session = harness.session();
        const conversationId = await harness.conversation(session);
        const t = harness.now();

        const older = await arrived(one, session, t);
        const newer = await arrived(two, session, t + 100);
        newer.hungUpAt = t + 200;
        await two.settle(newer, t + 300, exchangeOf(newer, conversationId, { utterance: "And on Sundays?" }));
        await vi.waitFor(() => expect(older.supersededAt).not.toBeNull());
        older.outcomeAt = t + 400;
        await one.settle(older, t + 400, exchangeOf(older, conversationId));
        const again = await arrived(one, session, t + 500);

        expect(one.replayFor(again, "And on Sundays?", t + 500)).not.toBeNull();
        expect(one.replayFor(again, "When do you open?", t + 500)).toBeNull();
      });
    });

    describe("a reply the caller interrupted", () => {
      const heardUntil = "We open at nine.  ​See";

      it("is reserved once, whichever instances the reports land on", async () => {
        const [one, two] = [harness.instance(), harness.instance()];
        const session = harness.session();
        await deliveredAnswer(one, session);
        const t = harness.now();

        const [left, right] = [await arrived(one, session, t), await arrived(two, session, t + 100)];
        const reservations = await Promise.all([
          one.reserveInterruption(left, heardUntil),
          two.reserveInterruption(right, heardUntil),
        ]);
        const taken = reservations.filter((reservation) => reservation !== null);

        expect(taken).toHaveLength(1);
        expect(taken[0]?.interruption).toEqual(expect.objectContaining({ heardCharacterCount: 20, spokenCharacterCount: 30 }));
        taken[0]?.recorded();
        await harness.settled();
        const later = await arrived(two, session, t + 200);
        await expect(two.reserveInterruption(later, heardUntil)).resolves.toBeNull();
      });

      it("is handed back to the next report when its note could not be recorded", async () => {
        const [one, two] = [harness.instance(), harness.instance()];
        const session = harness.session();
        await deliveredAnswer(one, session);
        const t = harness.now();

        const first = await arrived(one, session, t);
        const reservation = await one.reserveInterruption(first, heardUntil);
        expect(reservation).not.toBeNull();
        reservation?.failed();
        await harness.settled();
        const next = await arrived(two, session, t + 100);

        await expect(two.reserveInterruption(next, heardUntil)).resolves.not.toBeNull();
      });

      it("is taken over once the instance that reserved it has held it past a minute without a word", async () => {
        const [crashed, alive] = [harness.instance(), harness.instance()];
        const session = harness.session();
        await deliveredAnswer(alive, session);

        // Reserved, then never recorded nor handed back: its instance is gone.
        const abandoned = await arrived(crashed, session, harness.now());
        await expect(crashed.reserveInterruption(abandoned, heardUntil)).resolves.not.toBeNull();
        const early = await arrived(alive, session, harness.now());
        await expect(alive.reserveInterruption(early, heardUntil)).resolves.toBeNull();

        await harness.elapse(60_001);
        const late = await arrived(alive, session, harness.now());
        await expect(alive.reserveInterruption(late, heardUntil)).resolves.not.toBeNull();
      });

      it("is not reserved when the report is no strict prefix of what was spoken", async () => {
        const memory = harness.instance();
        const session = harness.session();
        await deliveredAnswer(memory, session);

        const next = await arrived(memory, session, harness.now());

        await expect(memory.reserveInterruption(next, "We close at")).resolves.toBeNull();
      });
    });

    describe("idle forgetting", () => {
      const heardUntil = "We open at nine.  ​See";

      it("forgets a session idle for longer than the replay window with nothing in flight", async () => {
        const [one, two] = [harness.instance(), harness.instance()];
        const [kept, forgotten] = [harness.session(), harness.session()];
        await deliveredAnswer(one, kept);
        await deliveredAnswer(one, forgotten);

        await harness.elapse(29_000);
        const soon = await arrived(two, kept, harness.now());
        await harness.elapse(2_000);
        const late = await arrived(two, forgotten, harness.now());

        await expect(two.reserveInterruption(soon, heardUntil)).resolves.not.toBeNull();
        await expect(two.reserveInterruption(late, heardUntil)).resolves.toBeNull();
      });

      it("forgets on the instance that served the session too", async () => {
        const memory = harness.instance();
        const session = harness.session();
        await deliveredAnswer(memory, session);

        await harness.elapse(31_000);
        const late = await arrived(memory, session, harness.now());

        await expect(memory.reserveInterruption(late, heardUntil)).resolves.toBeNull();
      });

      it("remembers a session while one of its requests is in flight, however long it runs", async () => {
        const [one, two] = [harness.instance(), harness.instance()];
        const session = harness.session();
        await deliveredAnswer(one, session);

        await arrived(one, session, harness.now());
        await harness.elapse(60_000);
        const next = await arrived(two, session, harness.now());

        await expect(two.reserveInterruption(next, heardUntil)).resolves.not.toBeNull();
      });

      it("stops counting a request in flight once it is older than a request lives, as when its instance crashed", async () => {
        const [crashed, alive] = [harness.instance(), harness.instance()];
        const session = harness.session();
        await deliveredAnswer(alive, session);

        // Never settled: the instance that took it is gone.
        await arrived(crashed, session, harness.now());
        await harness.elapse(5 * 60_000 + 1_000);
        const next = await arrived(alive, session, harness.now());

        await expect(alive.reserveInterruption(next, heardUntil)).resolves.toBeNull();
      });
    });
  });
};
