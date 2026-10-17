import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VOICE_BEHAVIOR } from "../../src/shared/domain/behaviorConfig.js";
import type { VoiceTurnEvent } from "../../src/modules/voiceChannel/domain.js";
import {
  applyVoiceTurnPolicy,
  type VoiceTurnDrain,
  type VoiceReplyEvent,
  type VoiceTurnPhase,
  type VoiceTurnPolicy,
  type VoiceTurnPolicyObserver,
} from "../../src/modules/voiceChannel/services/voiceTurnPolicy.js";

const conversationId = "55555555-5555-4555-8555-555555555555";

interface TimedEvent {
  atMs: number;
  event: VoiceTurnEvent;
}

interface TimedStep {
  atMs: number;
  event: VoiceReplyEvent;
}

/** A reply stream that yields each event at its time on the fake clock, and says whether it ran to its end. */
const timedReply = (steps: TimedStep[]) => {
  const state = { exhausted: false, closed: false };
  const events = (async function* (): AsyncGenerator<VoiceReplyEvent> {
    const startedAt = Date.now();
    try {
      for (const step of steps) {
        const wait = startedAt + step.atMs - Date.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        yield step.event;
      }
      state.exhausted = true;
    } finally {
      state.closed = true;
    }
  })();
  return { events, state };
};

const recordingObserver = () => {
  const calls: Array<[string, ...unknown[]]> = [];
  const drains: Array<Promise<VoiceTurnDrain>> = [];
  const observer: VoiceTurnPolicyObserver = {
    bridgeDue: (style, spoken) => calls.push(["bridgeDue", style, spoken]),
    turnLimitReached: (spoken) => calls.push(["turnLimitReached", spoken]),
    firstSpeech: (elapsedMs, bridged) => calls.push(["firstSpeech", elapsedMs, bridged]),
    drainingAfterLimit: (drained) => drains.push(drained),
  };
  return { observer, calls, drains };
};

const policy = (overrides: Partial<VoiceTurnPolicy> = {}): VoiceTurnPolicy => ({
  startedAt: Date.now(),
  now: () => Date.now(),
  bridgeAfterMs: VOICE_BEHAVIOR.bridgeAfterMs,
  bridgeAfterComposingIdleMs: 400,
  turnLimitMs: VOICE_BEHAVIOR.turnLimitMs,
  bridge: { style: "check", text: "Let me check." },
  fallbackLine: "Sorry, that took too long. Could you ask me again?",
  observer: recordingObserver().observer,
  ...overrides,
});

const run = async (events: AsyncIterable<VoiceReplyEvent>, turnPolicy: VoiceTurnPolicy): Promise<TimedEvent[]> => {
  const startedAt = Date.now();
  const seen: TimedEvent[] = [];
  const consumer = (async () => {
    for await (const event of applyVoiceTurnPolicy(events, turnPolicy)) {
      seen.push({ atMs: Date.now() - startedAt, event });
    }
  })();
  await vi.runAllTimersAsync();
  await consumer;
  return seen;
};

const speech = (text: string, last = false): VoiceTurnEvent => ({ type: "speech", text, last });
const outcome: VoiceTurnEvent = { type: "outcome", outcome: { kind: "continue" } };
const conversation: VoiceTurnEvent = { type: "conversation", conversationId };
const phase = (name: VoiceTurnPhase): VoiceReplyEvent => ({ type: "phase", phase: name });

describe("voice turn policy", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    try {
      // No deadline outlives the turn it watched.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("speaks the bridge line once when the turn shows no phase and no speech 2.5 s in", async () => {
    const { observer, calls } = recordingObserver();
    const { events } = timedReply([
      { atMs: 0, event: conversation },
      { atMs: 3_000, event: speech("We open at nine.", true) },
      { atMs: 3_000, event: outcome },
    ]);

    const seen = await run(events, policy({ observer }));

    expect(seen).toEqual([
      { atMs: 0, event: conversation },
      { atMs: 2_500, event: { type: "bridge", text: "Let me check." } },
      { atMs: 3_000, event: speech("We open at nine.", true) },
      { atMs: 3_000, event: outcome },
    ]);
    expect(calls).toEqual([["bridgeDue", "check", true], ["firstSpeech", 3_000, true]]);
  });

  it("leaves a prompt reply untouched", async () => {
    const { observer, calls } = recordingObserver();
    const reply: TimedEvent[] = [
      { atMs: 0, event: conversation },
      { atMs: 500, event: speech("We open at nine. ") },
      { atMs: 1_200, event: speech("See you!", true) },
      { atMs: 1_200, event: outcome },
    ];

    const seen = await run(timedReply(reply).events, policy({ observer }));

    expect(seen).toEqual(reply);
    expect(calls).toEqual([["firstSpeech", 500, false]]);
  });

  it("counts both deadlines from the turn's start, not from when the policy began", async () => {
    const { events } = timedReply([{ atMs: 3_000, event: speech("Yes.", true) }, { atMs: 3_000, event: outcome }]);

    const seen = await run(events, policy({ startedAt: Date.now() - 400 }));

    expect(seen[0]).toEqual({ atMs: 2_100, event: { type: "bridge", text: "Let me check." } });
  });

  it("speaks no bridge when the agent has no line for the turn, and says so to the observer", async () => {
    const { observer, calls } = recordingObserver();
    const { events } = timedReply([{ atMs: 3_000, event: speech("Yes.", true) }, { atMs: 3_000, event: outcome }]);

    const seen = await run(events, policy({ bridge: { style: "acknowledge", text: null }, observer }));

    expect(seen.map(({ event }) => event.type)).toEqual(["speech", "outcome"]);
    expect(calls).toEqual([["bridgeDue", "acknowledge", false], ["firstSpeech", 3_000, false]]);
  });

  it("speaks the fallback line at 10 s, ends its events there, and hands on the reply's drain so it persists", async () => {
    const { observer, calls, drains } = recordingObserver();
    const reply = timedReply([
      { atMs: 0, event: conversation },
      { atMs: 12_000, event: speech("We open at nine.", true) },
      { atMs: 12_000, event: outcome },
    ]);
    const startedAt = Date.now();
    const seen: TimedEvent[] = [];
    let endedAtMs: number | null = null;

    const consumer = (async () => {
      for await (const event of applyVoiceTurnPolicy(reply.events, policy({ observer }))) {
        seen.push({ atMs: Date.now() - startedAt, event });
      }
      endedAtMs = Date.now() - startedAt;
    })();
    await vi.runAllTimersAsync();
    await consumer;

    // The events end with the outcome at the limit; the reply finishes behind them.
    expect(endedAtMs).toBe(10_000);
    expect(drains).toHaveLength(1);
    await expect(drains[0]).resolves.toEqual({ failed: false });
    expect(seen).toEqual([
      { atMs: 0, event: conversation },
      { atMs: 2_500, event: { type: "bridge", text: "Let me check." } },
      { atMs: 10_000, event: speech("Sorry, that took too long. Could you ask me again?", true) },
      { atMs: 10_000, event: outcome },
    ]);
    expect(reply.state.exhausted).toBe(true);
    expect(calls).toEqual([
      ["bridgeDue", "check", true],
      ["turnLimitReached", true],
      ["firstSpeech", 10_000, true],
    ]);
  });

  it("reports a reply that fails while it drains after the limit through the drain, not the events", async () => {
    const { observer, drains } = recordingObserver();
    const failing = (async function* (): AsyncGenerator<VoiceTurnEvent> {
      yield conversation;
      await new Promise((resolve) => setTimeout(resolve, 12_000));
      throw new Error("provider down");
    })();

    const seen = await run(failing, policy({ observer }));

    expect(seen.map(({ event }) => event.type)).toEqual(["conversation", "bridge", "speech", "outcome"]);
    await expect(drains[0]).resolves.toEqual({ failed: true, error: new Error("provider down") });
  });

  it("keeps waiting for the reply past the limit when the agent has no fallback line", async () => {
    const { observer, calls } = recordingObserver();
    const reply: TimedEvent[] = [
      { atMs: 11_000, event: speech("We open at nine.", true) },
      { atMs: 11_000, event: outcome },
    ];

    const seen = await run(timedReply(reply).events, policy({ fallbackLine: null, observer }));

    expect(seen).toEqual([{ atMs: 2_500, event: { type: "bridge", text: "Let me check." } }, ...reply]);
    expect(calls).toEqual([
      ["bridgeDue", "check", true],
      ["turnLimitReached", false],
      ["firstSpeech", 11_000, true],
    ]);
  });

  it("waits for the reply however long it takes on a turn with no limit, and reports no limit", async () => {
    const { observer, calls } = recordingObserver();
    const reply: TimedEvent[] = [
      { atMs: 15_000, event: speech("A teammate will be with you shortly.", true) },
      { atMs: 15_000, event: outcome },
    ];

    const seen = await run(timedReply(reply).events, policy({ turnLimitMs: null, observer }));

    expect(seen).toEqual([{ atMs: 2_500, event: { type: "bridge", text: "Let me check." } }, ...reply]);
    expect(calls).toEqual([["bridgeDue", "check", true], ["firstSpeech", 15_000, true]]);
  });

  it("speaks no bridge in any phase on a turn with none, and reports none", async () => {
    const { observer, calls } = recordingObserver();
    const reply: TimedStep[] = [
      { atMs: 0, event: phase("interpreting") },
      { atMs: 300, event: phase("searching") },
      { atMs: 1_100, event: phase("composing") },
      { atMs: 3_000, event: speech("A teammate will be with you shortly.", true) },
      { atMs: 3_000, event: outcome },
    ];

    const seen = await run(timedReply(reply).events, policy({ bridge: null, observer }));

    expect(seen).toEqual([
      { atMs: 3_000, event: speech("A teammate will be with you shortly.", true) },
      { atMs: 3_000, event: outcome },
    ]);
    expect(calls).toEqual([["firstSpeech", 3_000, false]]);
  });

  it("disarms both deadlines once an outcome passes with nothing spoken", async () => {
    const { observer, calls } = recordingObserver();
    const reply = timedReply([
      { atMs: 0, event: conversation },
      { atMs: 100, event: outcome },
      // A superseded turn's stream may still be winding down well past the limit.
      { atMs: 10_000, event: conversation },
    ]);

    const seen = await run(reply.events, policy({ observer }));

    expect(seen).toEqual([
      { atMs: 0, event: conversation },
      { atMs: 100, event: outcome },
      { atMs: 10_000, event: conversation },
    ]);
    expect(calls).toEqual([]);
  });

  it("speaks no bridge when the reply fails before the bridge delay", async () => {
    const { observer, calls } = recordingObserver();
    const failing = (async function* (): AsyncGenerator<VoiceTurnEvent> {
      yield conversation;
      await new Promise((resolve) => setTimeout(resolve, 300));
      throw new Error("provider down");
    })();
    const seen: VoiceTurnEvent[] = [];

    const consumer = (async () => {
      for await (const event of applyVoiceTurnPolicy(failing, policy({ observer }))) seen.push(event);
    })();
    const settled = consumer.then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await settled).toEqual(new Error("provider down"));
    expect(seen).toEqual([conversation]);
    expect(calls).toEqual([]);
  });

  it("speaks no bridge when the turn is aborted while the policy waits for it", async () => {
    const { observer, calls } = recordingObserver();
    const abort = new AbortController();
    const aborted = (async function* (): AsyncGenerator<VoiceTurnEvent> {
      yield conversation;
      await new Promise((_resolve, reject) => {
        abort.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), {
          once: true,
        });
      });
    })();
    const seen: VoiceTurnEvent[] = [];

    const consumer = (async () => {
      for await (const event of applyVoiceTurnPolicy(aborted, policy({ observer }))) seen.push(event);
    })();
    const settled = consumer.then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(400);
    abort.abort();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await settled).toMatchObject({ name: "AbortError" });
    expect(seen).toEqual([conversation]);
    expect(calls).toEqual([]);
  });

  describe("deciding the bridge from the turn's phase", () => {
    it("bridges a retrieval turn the moment it starts searching, not on a timer", async () => {
      const { observer, calls } = recordingObserver();
      const { events } = timedReply([
        { atMs: 0, event: conversation },
        { atMs: 0, event: phase("interpreting") },
        { atMs: 1_100, event: phase("searching") },
        { atMs: 3_000, event: speech("We open at nine.", true) },
        { atMs: 3_000, event: outcome },
      ]);

      const seen = await run(events, policy({ observer }));

      expect(seen).toEqual([
        { atMs: 0, event: conversation },
        { atMs: 1_100, event: { type: "bridge", text: "Let me check." } },
        { atMs: 3_000, event: speech("We open at nine.", true) },
        { atMs: 3_000, event: outcome },
      ]);
      expect(calls).toEqual([["bridgeDue", "check", true], ["firstSpeech", 3_000, true]]);
    });

    it("bridges a composing turn that has not spoken 400 ms after it started composing", async () => {
      const { events } = timedReply([
        { atMs: 0, event: phase("interpreting") },
        { atMs: 1_100, event: phase("composing") },
        { atMs: 3_000, event: speech("We open at nine.", true) },
        { atMs: 3_000, event: outcome },
      ]);

      const seen = await run(events, policy());

      expect(seen).toEqual([
        { atMs: 1_500, event: { type: "bridge", text: "Let me check." } },
        { atMs: 3_000, event: speech("We open at nine.", true) },
        { atMs: 3_000, event: outcome },
      ]);
    });

    it("lets a quick reply speak without a bridge", async () => {
      const { observer, calls } = recordingObserver();
      const reply: TimedStep[] = [
        { atMs: 0, event: phase("interpreting") },
        { atMs: 1_100, event: phase("composing") },
        { atMs: 1_150, event: speech("Hi!", true) },
        { atMs: 1_150, event: outcome },
      ];

      const seen = await run(timedReply(reply).events, policy({ observer }));

      expect(seen).toEqual([{ atMs: 1_150, event: speech("Hi!", true) }, { atMs: 1_150, event: outcome }]);
      expect(calls).toEqual([["firstSpeech", 1_150, false]]);
    });

    it("keeps the 2.5 s fallback armed while the turn is still interpreting", async () => {
      const { events } = timedReply([
        { atMs: 0, event: phase("interpreting") },
        { atMs: 3_000, event: speech("We open at nine.", true) },
        { atMs: 3_000, event: outcome },
      ]);

      const seen = await run(events, policy());

      expect(seen[0]).toEqual({ atMs: 2_500, event: { type: "bridge", text: "Let me check." } });
    });

    it("speaks no bridge when speech comes before any phase", async () => {
      const { observer, calls } = recordingObserver();
      const { events } = timedReply([
        { atMs: 500, event: speech("Hello.", true) },
        { atMs: 500, event: outcome },
        { atMs: 2_000, event: phase("searching") },
      ]);

      const seen = await run(events, policy({ observer }));

      expect(seen.map(({ event }) => event.type)).toEqual(["speech", "outcome"]);
      expect(calls).toEqual([["firstSpeech", 500, false]]);
    });

    it("still speaks the fallback line at 10 s after a composing bridge", async () => {
      const { events } = timedReply([
        { atMs: 1_100, event: phase("composing") },
        { atMs: 12_000, event: speech("We open at nine.", true) },
        { atMs: 12_000, event: outcome },
      ]);

      const seen = await run(events, policy());

      expect(seen).toEqual([
        { atMs: 1_500, event: { type: "bridge", text: "Let me check." } },
        { atMs: 10_000, event: speech("Sorry, that took too long. Could you ask me again?", true) },
        { atMs: 10_000, event: outcome },
      ]);
    });

    it("bridges at most once when the turn moves from composing to searching", async () => {
      const { events } = timedReply([
        { atMs: 1_100, event: phase("composing") },
        { atMs: 1_600, event: phase("searching") },
        { atMs: 3_000, event: speech("We open at nine.", true) },
        { atMs: 3_000, event: outcome },
      ]);

      const seen = await run(events, policy());

      expect(seen.filter(({ event }) => event.type === "bridge")).toEqual([
        { atMs: 1_500, event: { type: "bridge", text: "Let me check." } },
      ]);
    });
  });

  it("closes the reply stream when its consumer stops early", async () => {
    const reply = timedReply([{ atMs: 0, event: conversation }, { atMs: 100, event: speech("Yes.", true) }]);

    for await (const event of applyVoiceTurnPolicy(reply.events, policy())) {
      expect(event).toEqual(conversation);
      break;
    }

    expect(reply.state.closed).toBe(true);
    expect(reply.state.exhausted).toBe(false);
  });
});
