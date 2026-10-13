import type { VoiceBridgeStyle } from "../../agents/public.js";
import type { VoiceTurnEvent } from "../domain.js";
import type { VoiceTurnLines } from "./voiceLines.js";

/** What the policy reports as it acts, for metrics and the turn's log record. Never the lines' text. */
export interface VoiceTurnPolicyObserver {
  /** The bridge delay passed with nothing spoken; `spoken` is false when the agent has no line for the turn. */
  bridgeDue(style: VoiceBridgeStyle, spoken: boolean): void;
  /** The turn limit passed with nothing spoken; `spoken` is false when the agent has no fallback line. */
  turnLimitReached(spoken: boolean): void;
  /** The first speech left the policy, `elapsedMs` after the turn started. */
  firstSpeech(elapsedMs: number, bridged: boolean): void;
}

export interface VoiceTurnPolicy extends VoiceTurnLines {
  /** When the turn started on `now`'s clock; both deadlines count from here. */
  startedAt: number;
  now: () => number;
  bridgeAfterMs: number;
  turnLimitMs: number;
  observer: VoiceTurnPolicyObserver;
}

type Deadline = "bridge" | "limit";

type Pull =
  | { kind: "event"; step: IteratorResult<VoiceTurnEvent> }
  | { kind: "deadline"; deadline: Deadline };

const waitFor = (pull: Promise<IteratorResult<VoiceTurnEvent>>, deadline: Deadline, delayMs: number): Promise<Pull> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<Pull>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "deadline", deadline }), Math.max(0, delayMs));
  });
  return Promise.race([pull.then((step): Pull => ({ kind: "event", step })), elapsed])
    .finally(() => clearTimeout(timer));
};

/**
 * The vendor-neutral turn policy over a voice turn's events. Until the first speech it watches two
 * deadlines: past `bridgeAfterMs` it speaks the bridge line once, and past `turnLimitMs` it speaks
 * the fallback line and closes the turn with `continue`. An outcome disarms both. After the limit it forwards nothing more
 * but keeps draining the reply, so the chat turn still finishes and is stored as usual — the stored
 * answer is then not what the caller heard. Everything else passes through untouched.
 */
export async function* applyVoiceTurnPolicy(
  events: AsyncIterable<VoiceTurnEvent>,
  policy: VoiceTurnPolicy,
): AsyncGenerator<VoiceTurnEvent> {
  const iterator = events[Symbol.asyncIterator]();
  const elapsed = () => policy.now() - policy.startedAt;
  let spoken = false;
  // A turn superseded before it spoke ends on an outcome alone; nothing may follow its outcome.
  let ended = false;
  let bridged = false;
  let bridgeHandled = false;
  let limitHandled = false;
  let finished = false;
  let pending: Promise<IteratorResult<VoiceTurnEvent>> | undefined;

  const nextDeadline = (): { deadline: Deadline; delayMs: number } | null => {
    if (spoken || ended) return null;
    if (!bridgeHandled) return { deadline: "bridge", delayMs: policy.bridgeAfterMs - elapsed() };
    if (!limitHandled) return { deadline: "limit", delayMs: policy.turnLimitMs - elapsed() };
    return null;
  };

  try {
    for (;;) {
      pending ??= iterator.next();
      const due = nextDeadline();
      const pull: Pull = due ? await waitFor(pending, due.deadline, due.delayMs) : { kind: "event", step: await pending };

      if (pull.kind === "deadline" && pull.deadline === "bridge") {
        bridgeHandled = true;
        policy.observer.bridgeDue(policy.bridge.style, policy.bridge.text !== null);
        if (policy.bridge.text !== null) {
          bridged = true;
          yield { type: "bridge", text: policy.bridge.text };
        }
        continue;
      }

      if (pull.kind === "deadline") {
        limitHandled = true;
        policy.observer.turnLimitReached(policy.fallbackLine !== null);
        if (policy.fallbackLine === null) continue;
        spoken = true;
        policy.observer.firstSpeech(elapsed(), bridged);
        yield { type: "speech", text: policy.fallbackLine, last: true };
        yield { type: "outcome", outcome: { kind: "continue" } };
        for (let step = await pending; !step.done; step = await iterator.next()) {
          // Drained unheard: the reply finishes and persists, but the caller has moved on.
        }
        finished = true;
        return;
      }

      pending = undefined;
      if (pull.step.done) {
        finished = true;
        return;
      }
      const event = pull.step.value;
      if (event.type === "speech" && !spoken) {
        spoken = true;
        policy.observer.firstSpeech(elapsed(), bridged);
      }
      if (event.type === "outcome") {
        ended = true;
      }
      yield event;
    }
  } finally {
    if (!finished) {
      await iterator.return?.();
    }
  }
}
