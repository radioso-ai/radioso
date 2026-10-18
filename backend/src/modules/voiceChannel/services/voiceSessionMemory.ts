import { heardSpeechOf, type ReachedSpeech } from "./heardSpeech.js";

/** One request's place in its session, from its arrival until its turn ends. */
export interface VoiceTurnClaim {
  /** Arrival order within the process. */
  readonly sequence: number;
  /** The request of the session still in flight when this one arrived, which this one overtook. */
  readonly overtook: VoiceTurnClaim | null;
  /** When a newer request of the session arrived while this one was in flight. */
  supersededAt: number | null;
  /** When the runtime closed this request before the turn's outcome reached it. */
  hungUpAt: number | null;
  /** When the turn's outcome left the turn. */
  outcomeAt: number | null;
  settled: boolean;
}

/** A turn's stored answer. */
export interface VoiceStoredReply {
  messageId: string;
  text: string;
  /** The answer is the heard part of a reply cut off mid-stream, stored marked: there is nothing more to measure. */
  partial?: boolean;
}

/** The newest exchange whose user message the session's conversation keeps. */
export interface VoiceExchange {
  utterance: string;
  conversationId: string;
  /** The stored answer; null when the conversation keeps the user message without one. */
  reply: VoiceStoredReply | null;
  /** What the turn spoke, piece by piece; null when the caller heard the fallback line in place of the reply. */
  spoken: ReachedSpeech | null;
  /** When the runtime hung up on the turn, or a newer request overtook it, before its outcome. */
  cutOffAt: number | null;
}

/** An exchange with a stored answer, which a re-request may hear again. */
export type ReplayableVoiceExchange = VoiceExchange & { reply: NonNullable<VoiceExchange["reply"]> };

/** How much of a stored reply the caller heard before speaking over it. */
interface VoiceReplyInterruption {
  conversationId: string;
  assistantMessageId: string;
  heardCharacterCount: number;
  spokenCharacterCount: number;
}

/**
 * An interruption held for one request while its note is written: `recorded` once the note is
 * durable, so no later report repeats it; `failed` hands it back, so the next report records it.
 */
interface VoiceReplyInterruptionReservation {
  interruption: VoiceReplyInterruption;
  recorded(): void;
  failed(): void;
}

/** Where an exchange's interruption note stands: none yet, being written, or durable. */
type InterruptionNote = "none" | "pending" | "recorded";

interface SessionState {
  newest: VoiceTurnClaim | null;
  /** Requests not yet settled. */
  open: number;
  /** Chat turns still running for the session's requests. */
  chatTurns: number;
  lastBridge: { at: number; claim: VoiceTurnClaim } | null;
  lastExchange: { exchange: VoiceExchange; sequence: number } | null;
  touchedAt: number;
}

interface VoiceSessionMemoryWindows {
  /** How long a cut-off exchange stays replayable. */
  replayWindowMs: number;
  /** How long a superseded turn's bridge line keeps the next turn from speaking another. */
  bridgeAfterMs: number;
}

export const sameUtterance = (left: string, right: string): boolean =>
  left.replace(/\s+/gu, " ").trim() === right.replace(/\s+/gu, " ").trim();

/**
 * When the turn lost its caller before its outcome left: overtaken or hung up on; null when delivered.
 * A loss on the outcome's own millisecond still counts: the route reports a hang-up only before the
 * outcome left, so equal clock readings mean the loss came first.
 */
export const cutOffAt = (claim: VoiceTurnClaim): number | null => {
  const lost = [claim.supersededAt, claim.hungUpAt]
    .filter((at): at is number => at !== null && (claim.outcomeAt === null || at <= claim.outcomeAt));
  return lost.length > 0 ? Math.min(...lost) : null;
};

/**
 * What this process remembers of each voice session between its requests: which request is the
 * newest (it supersedes the ones before it), when a superseded turn last spoke a bridge line, and
 * the last exchange a re-request may replay or report as interrupted. In-process only: requests of
 * one session that land on different instances do not see each other here. A session is forgotten
 * once it has been idle for longer than both windows.
 */
export class VoiceSessionMemory {
  private readonly sessions = new Map<string, SessionState>();
  /** Where each settled exchange's interruption note stands, whether or not it is still the session's newest. */
  private readonly interruptionNotes = new WeakMap<VoiceExchange, InterruptionNote>();
  private readonly retainMs: number;
  private arrivals = 0;

  constructor(private readonly windows: VoiceSessionMemoryWindows) {
    this.retainMs = Math.max(windows.replayWindowMs, windows.bridgeAfterMs);
  }

  /** Registers a request of the session; the request in flight before it is superseded from now. */
  arrive(sessionKey: string, now: number): VoiceTurnClaim {
    this.forgetIdle(now);
    const state = this.stateOf(sessionKey, now);
    const previous = state.newest;
    if (previous && !previous.settled) {
      previous.supersededAt ??= now;
    }
    const overtook = previous && !previous.settled ? previous : null;
    const claim: VoiceTurnClaim = { sequence: ++this.arrivals, overtook, supersededAt: null, hungUpAt: null, outcomeAt: null, settled: false };
    state.newest = claim;
    state.open += 1;
    return claim;
  }

  /**
   * Ends the request's hold on the session. `exchange` is what the conversation now keeps of the
   * turn; undefined when it keeps nothing, so the exchange before it stays the newest.
   */
  settle(sessionKey: string, claim: VoiceTurnClaim, now: number, exchange: VoiceExchange | undefined): void {
    const state = this.stateOf(sessionKey, now);
    claim.settled = true;
    state.open = Math.max(0, state.open - 1);
    if (state.newest === claim) {
      state.newest = null;
    }
    if (exchange) {
      // A reply stored as its heard part carries its marker already, so no report of it is noted again.
      this.interruptionNotes.set(exchange, exchange.reply?.partial ? "recorded" : "none");
    }
    if (exchange && (state.lastExchange === null || state.lastExchange.sequence < claim.sequence)) {
      state.lastExchange = { exchange, sequence: claim.sequence };
    }
  }

  chatTurnStarted(sessionKey: string, now: number): void {
    this.stateOf(sessionKey, now).chatTurns += 1;
  }

  chatTurnEnded(sessionKey: string, now: number): void {
    const state = this.stateOf(sessionKey, now);
    state.chatTurns = Math.max(0, state.chatTurns - 1);
  }

  /**
   * The caller never heard the request's turn although its outcome left (a switch of the call's
   * language no follow-up spoke): its exchange, once settled and still the session's newest, reads
   * as cut off at `at`, so an identical re-request within the replay window hears the answer.
   */
  markUnheard(sessionKey: string, claim: VoiceTurnClaim, at: number): void {
    const last = this.sessions.get(sessionKey)?.lastExchange;
    if (last?.sequence === claim.sequence) {
      last.exchange.cutOffAt ??= at;
    }
  }

  bridgeSpoken(sessionKey: string, claim: VoiceTurnClaim, now: number): void {
    this.stateOf(sessionKey, now).lastBridge = { at: now, claim };
  }

  /**
   * Whether the request may speak its bridge line now: not once a newer request owns the session,
   * and not while a bridge from a turn that lost its caller is fresher than the bridge delay.
   */
  mayBridge(sessionKey: string, claim: VoiceTurnClaim, now: number): boolean {
    if (claim.supersededAt !== null) {
      return false;
    }
    const last = this.stateOf(sessionKey, now).lastBridge;
    return !(last && last.claim !== claim && cutOffAt(last.claim) !== null && now - last.at < this.windows.bridgeAfterMs);
  }

  /**
   * The stored answer to speak again for `utterance`: the session's newest exchange asked the
   * same, has a whole answer, lost its caller within the replay window, and no chat turn is running.
   */
  replayFor(sessionKey: string, utterance: string, now: number): ReplayableVoiceExchange | null {
    const state = this.sessions.get(sessionKey);
    const exchange = state?.lastExchange?.exchange;
    // A reply stored as its heard part is not heard again: a new turn finishes the answer instead.
    if (!state || !exchange?.reply || exchange.reply.partial || exchange.cutOffAt === null || state.chatTurns > 0) {
      return null;
    }
    const withinWindow = now - exchange.cutOffAt <= this.windows.replayWindowMs;
    return withinWindow && sameUtterance(exchange.utterance, utterance) ? { ...exchange, reply: exchange.reply } : null;
  }

  /**
   * Reserves the session's newest exchange's reply as far as the caller heard it; see
   * {@link reserveInterruptionOf}.
   */
  reserveInterruption(sessionKey: string, heardUntil: string): VoiceReplyInterruptionReservation | null {
    const last = this.sessions.get(sessionKey)?.lastExchange?.exchange;
    return last ? this.reserveInterruptionOf(last, heardUntil) : null;
  }

  /**
   * Reserves `exchange`'s reply as far as the caller heard it, while the vendor reports it cut
   * short and no note of it is recorded or being written; null when the report is no prefix of
   * what was spoken, leaves none of the reply's words out, or the reply is a heard part stored
   * marked.
   */
  reserveInterruptionOf(exchange: VoiceExchange, heardUntil: string): VoiceReplyInterruptionReservation | null {
    const { reply, spoken, conversationId } = exchange;
    if (this.interruptionNotes.get(exchange) !== "none" || !reply || !spoken) {
      return null;
    }
    const heard = heardSpeechOf(spoken, heardUntil);
    if (!heard || heard.answerHeardCharacterCount >= heard.answerSpokenCharacterCount) {
      return null;
    }
    this.interruptionNotes.set(exchange, "pending");
    return {
      interruption: {
        conversationId,
        assistantMessageId: reply.messageId,
        heardCharacterCount: heard.answerHeardCharacterCount,
        spokenCharacterCount: heard.answerSpokenCharacterCount,
      },
      recorded: () => {
        this.interruptionNotes.set(exchange, "recorded");
      },
      failed: () => {
        this.interruptionNotes.set(exchange, "none");
      },
    };
  }

  private stateOf(sessionKey: string, now: number): SessionState {
    let state = this.sessions.get(sessionKey);
    if (!state) {
      state = { newest: null, open: 0, chatTurns: 0, lastBridge: null, lastExchange: null, touchedAt: now };
      this.sessions.set(sessionKey, state);
    }
    state.touchedAt = now;
    return state;
  }

  private forgetIdle(now: number): void {
    for (const [sessionKey, state] of this.sessions) {
      if (state.open === 0 && state.chatTurns === 0 && now - state.touchedAt > this.retainMs) {
        this.sessions.delete(sessionKey);
      }
    }
  }
}
