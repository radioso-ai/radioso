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
  /**
   * The limit ended the turn's events while its reply still runs: `drained` settles once the
   * reply has finished unheard, with its failure if it failed. Called before the outcome leaves.
   */
  drainingAfterLimit(drained: Promise<VoiceTurnDrain>): void;
}

/** How a reply drained after the turn limit ended. */
export type VoiceTurnDrain = { failed: false } | { failed: true; error: unknown };

/** Pulls a reply nobody hears any more to its end, so the chat turn still finishes and is stored. */
const drainUnheard = async (
  iterator: AsyncIterator<VoiceReplyEvent>,
  pending: Promise<IteratorResult<VoiceReplyEvent>>,
): Promise<VoiceTurnDrain> => {
  try {
    for (let step = await pending; !step.done; step = await iterator.next()) {
      // Drained unheard: the reply finishes and persists, but the caller has moved on.
    }
    return { failed: false };
  } catch (error) {
    return { failed: true, error };
  }
};

/** Where the chat turn is: every turn starts interpreting, then searches (retrieval) or composes. */
export type VoiceTurnPhase = "interpreting" | "searching" | "composing";

/**
 * What the policy reads: the turn's events, plus phase markers the turn service derives from the
 * chat stream. Markers are internal to the voice services; the policy never passes one on.
 */
export type VoiceReplyEvent = VoiceTurnEvent | { type: "phase"; phase: VoiceTurnPhase };

export interface VoiceTurnPolicy extends Omit<VoiceTurnLines, "bridge"> {
  /** The line that covers the wait; null: the turn has no bridge. */
  bridge: VoiceTurnLines["bridge"] | null;
  /** When the turn started on `now`'s clock; the fallback bridge and the limit count from here. */
  startedAt: number;
  now: () => number;
  /** Bridge when the turn has neither searched nor composed this long into it. */
  bridgeAfterMs: number;
  /** Bridge when this long has passed since the turn started composing and nothing was spoken. */
  bridgeAfterComposingIdleMs: number;
  /** Past this with nothing spoken, the fallback line ends the turn; null: the turn has no limit. */
  turnLimitMs: number | null;
  /**
   * Asked when the bridge falls due; false holds the line back for the rest of the turn (a newer
   * request owns the session, or a turn this one superseded spoke a bridge moments ago). Absent: true.
   */
  mayBridge?: () => boolean;
  observer: VoiceTurnPolicyObserver;
}

type Deadline = "bridge" | "limit";

type Pull =
  | { kind: "event"; step: IteratorResult<VoiceReplyEvent> }
  | { kind: "deadline"; deadline: Deadline };

const waitFor = (pull: Promise<IteratorResult<VoiceReplyEvent>>, deadline: Deadline, delayMs: number): Promise<Pull> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<Pull>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "deadline", deadline }), Math.max(0, delayMs));
  });
  return Promise.race([pull.then((step): Pull => ({ kind: "event", step })), elapsed])
    .finally(() => clearTimeout(timer));
};

/**
 * The vendor-neutral turn policy over a voice turn's events. Until the first speech it speaks the
 * bridge line at most once, on a turn that has one, decided by the turn's phase: at once when the
 * turn starts searching, `bridgeAfterComposingIdleMs` after it starts composing without speech, or
 * `bridgeAfterMs` into a turn that has done neither. Past `turnLimitMs`, on a turn that has one, it speaks the fallback
 * line and closes the turn with `continue`. An outcome disarms both. After the limit its events
 * end with the outcome, and the reply drains behind them (`observer.drainingAfterLimit`), so the
 * chat turn still finishes and is stored as usual — the stored answer is then not what the
 * caller heard. Phase markers are dropped; everything else passes through.
 */
export async function* applyVoiceTurnPolicy(
  events: AsyncIterable<VoiceReplyEvent>,
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
  /** When the turn started composing, in ms since its start; null until it does. */
  let composingAt: number | null = null;
  let pending: Promise<IteratorResult<VoiceReplyEvent>> | undefined;

  const bridgeAt = (): number => (composingAt === null ? policy.bridgeAfterMs : composingAt + policy.bridgeAfterComposingIdleMs);

  /** The earlier of the armed deadlines. */
  const nextDeadline = (): { deadline: Deadline; delayMs: number } | null => {
    if (spoken || ended) return null;
    const armed: Array<{ deadline: Deadline; atMs: number }> = [
      ...(bridgeHandled || policy.bridge === null ? [] : [{ deadline: "bridge" as const, atMs: bridgeAt() }]),
      ...(limitHandled || policy.turnLimitMs === null ? [] : [{ deadline: "limit" as const, atMs: policy.turnLimitMs }]),
    ];
    const first = armed.reduce<{ deadline: Deadline; atMs: number } | null>(
      (earliest, candidate) => (earliest === null || candidate.atMs < earliest.atMs ? candidate : earliest),
      null,
    );
    return first ? { deadline: first.deadline, delayMs: first.atMs - elapsed() } : null;
  };

  /** Settles the bridge once; the line when the agent has one for the turn and the session may hear it. */
  const bridgeNow = (): VoiceTurnEvent | null => {
    bridgeHandled = true;
    const { bridge } = policy;
    if (bridge === null || (policy.mayBridge && !policy.mayBridge())) return null;
    policy.observer.bridgeDue(bridge.style, bridge.text !== null);
    if (bridge.text === null) return null;
    bridged = true;
    return { type: "bridge", text: bridge.text };
  };

  try {
    for (;;) {
      pending ??= iterator.next();
      const due = nextDeadline();
      const pull: Pull = due ? await waitFor(pending, due.deadline, due.delayMs) : { kind: "event", step: await pending };

      if (pull.kind === "deadline" && pull.deadline === "bridge") {
        const bridge = bridgeNow();
        if (bridge) yield bridge;
        continue;
      }

      if (pull.kind === "deadline") {
        limitHandled = true;
        policy.observer.turnLimitReached(policy.fallbackLine !== null);
        if (policy.fallbackLine === null) continue;
        spoken = true;
        policy.observer.firstSpeech(elapsed(), bridged);
        yield { type: "speech", text: policy.fallbackLine, last: true };
        // The reply is handed on before the outcome leaves, so the events can end with it.
        finished = true;
        policy.observer.drainingAfterLimit(drainUnheard(iterator, pending ?? iterator.next()));
        yield { type: "outcome", outcome: { kind: "continue" } };
        return;
      }

      pending = undefined;
      if (pull.step.done) {
        finished = true;
        return;
      }
      const event = pull.step.value;
      if (event.type === "phase") {
        const open = !bridgeHandled && !spoken && !ended;
        if (open && event.phase === "searching") {
          // A retrieval turn always has seconds of work ahead.
          const bridge = bridgeNow();
          if (bridge) yield bridge;
        } else if (event.phase === "composing") {
          composingAt ??= elapsed();
        }
        continue;
      }
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

/** The reply without its phase markers, for a turn that runs without the policy. */
export async function* withoutPhaseMarkers(events: AsyncIterable<VoiceReplyEvent>): AsyncGenerator<VoiceTurnEvent> {
  for await (const event of events) {
    if (event.type !== "phase") {
      yield event;
    }
  }
}
