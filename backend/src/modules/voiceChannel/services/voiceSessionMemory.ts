import { createHash } from "node:crypto";

import type { AppLogger } from "../../../shared/observability/logger.js";
import type { VoiceSessionRef } from "../domain.js";
import { heardPrefixLength, spokenLength } from "./speechText.js";

/** One request's place in its session, from its arrival until its turn ends. */
export interface VoiceTurnClaim {
  /** Arrival number: rises in arrival order across every instance that serves the session. */
  readonly sequence: string;
  /** When a newer request of the session arrived while this one was in flight. */
  supersededAt: number | null;
  /** When the runtime closed this request before the turn's outcome reached it. */
  hungUpAt: number | null;
  /** When the turn's outcome left the turn. */
  outcomeAt: number | null;
  settled: boolean;
}

/** What the caller could hear of a turn, in order. */
export interface VoiceSpokenTurn {
  bridge: string | null;
  reply: string;
}

/** The newest exchange whose user message the session's conversation keeps. */
export interface VoiceExchange {
  utterance: string;
  conversationId: string;
  /** The stored answer; null when the conversation keeps the user message without one. */
  reply: { messageId: string; text: string } | null;
  /** What was spoken; null when the caller heard the fallback line in place of the reply. */
  spoken: VoiceSpokenTurn | null;
  /** When the runtime hung up on the turn, or a newer request overtook it, before its outcome. */
  cutOffAt: number | null;
}

/** A stored answer a re-request may hear again. */
export interface ReplayableVoiceExchange {
  conversationId: string;
  reply: { messageId: string; text: string };
}

/** An exchange as the session keeps it: the caller's words only as a digest. */
export interface RememberedVoiceExchange {
  utteranceDigest: string;
  conversationId: string;
  reply: VoiceExchange["reply"];
  spoken: VoiceSpokenTurn | null;
  cutOffAt: number | null;
}

/** Where the note of an exchange's interruption stands: none yet, being written, or durable. */
export type VoiceInterruptionNoteState = "none" | "pending" | "recorded";

/** What the session remembered as a request arrived, and the request's place in it. */
export interface VoiceSessionArrival {
  /** The session's memory, which the request's later writes address. */
  sessionId: string;
  sequence: string;
  /** The request this one overtook, which may still be in flight; its instance is told. */
  supersededSequence: string | null;
  /** The session's other requests still in flight. */
  inFlightSequences: string[];
  /** The last bridge line; `cutOff` is null while the request that spoke it is in flight. */
  lastBridge: { sequence: string; at: number; cutOff: boolean | null } | null;
  lastExchange: { sequence: string; exchange: RememberedVoiceExchange; note: VoiceInterruptionNoteState } | null;
}

/** How long the session's memory lasts, as every store applies it. */
export interface VoiceSessionRetention {
  /** A session idle this long with no request in flight is forgotten. */
  forgetAfterMs: number;
  /** A request still unsettled this long after it arrived counts as gone: its instance crashed. */
  requestLifetimeMs: number;
}

/** Where every instance serving a session keeps what the session remembers. */
export interface VoiceSessionMemoryStore {
  /**
   * Registers a request with the next arrival number. The session's last exchange is forgotten
   * first when the session has been idle past `forgetAfterMs` with nothing in flight. The request it
   * overtook, unless that one already settled, is announced on the notice source.
   */
  arrive(input: { session: VoiceSessionRef; now: number; retention: VoiceSessionRetention }): Promise<VoiceSessionArrival>;
  /**
   * Ends a request: records its exchange unless a newer one is recorded, and whether it lost its
   * caller when it spoke the session's last bridge line. Also deletes forgotten sessions.
   */
  settle(input: {
    sessionId: string;
    sequence: string;
    now: number;
    cutOff: boolean;
    exchange: RememberedVoiceExchange | null;
    retention: VoiceSessionRetention;
  }): Promise<void>;
  /** Records a bridge line, unless a newer request of the session already spoke one. */
  bridgeSpoken(input: { sessionId: string; sequence: string; at: number }): Promise<void>;
  /** Takes the exchange's interruption note for writing; false when it is recorded or being written. */
  claimInterruptionNote(input: { sessionId: string; exchangeSequence: string }): Promise<boolean>;
  /** Marks a taken note recorded, or hands it back so a later report writes it. */
  releaseInterruptionNote(input: { sessionId: string; exchangeSequence: string; recorded: boolean }): Promise<void>;
  /** When each of these requests was overtaken, for the ones a newer request overtook. */
  supersededAt(sequences: string[]): Promise<Map<string, number>>;
}

interface VoiceSessionNoticeHandlers {
  /** A newer request of the request's session arrived at `at`. */
  superseded(notice: { sequence: string; at: number }): void;
  /** Notices are heard from now on; anything announced before may have been missed. */
  listening(): void;
  /** Notices stopped arriving until the next `listening`. */
  interrupted(): void;
}

/** Wakes the instance running an overtaken request; the store stays the truth. */
export interface VoiceSessionNoticeSource {
  subscribe(handlers: VoiceSessionNoticeHandlers): () => void;
}

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
export interface VoiceReplyInterruptionReservation {
  interruption: VoiceReplyInterruption;
  recorded(): void;
  failed(): void;
}

interface VoiceSessionMemoryWindows {
  /** How long a cut-off exchange stays replayable. */
  replayWindowMs: number;
  /** How long a superseded turn's bridge line keeps the next turn from speaking another. */
  bridgeAfterMs: number;
}

/** A request whose instance stopped settling it for this long has crashed or stalled. */
const REQUEST_LIFETIME_MS = 5 * 60_000;

/** A failed catch-up is retried after this delay, doubling up to the maximum. */
const CATCH_UP_RETRY_INITIAL_MS = 250;
const CATCH_UP_RETRY_MAX_MS = 5_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms).unref();
});

/** Requests of one session that this process runs, and the order its writes for them go out in. */
interface LocalSession {
  readonly key: string;
  readonly claims: Set<VoiceTurnClaim>;
  arriving: number;
  /** Each write for the session, in this process's call order, so an arrival reads the ones before it. */
  tail: Promise<void>;
}

interface ClaimContext {
  readonly local: LocalSession;
  readonly arrival: VoiceSessionArrival;
  chatTurnRunning: boolean;
}

const sessionKeyOf = (session: VoiceSessionRef): string =>
  JSON.stringify([session.workspaceId, session.agentId, session.vendor, session.sessionKey]);

/** The caller's words, whitespace aside, as a digest: equal utterances share one. */
const utteranceDigest = (utterance: string): string =>
  createHash("sha256").update(utterance.replace(/\s+/gu, " ").trim()).digest("base64url");

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
 * What each voice session remembers between its requests, shared by every instance through the
 * store: which request is the newest (it supersedes the ones before it), when a request that lost
 * its caller last spoke a bridge line, and the last exchange a re-request may replay or report as
 * interrupted. Arriving and settling a request are one store round trip each; everything a turn
 * asks while it runs is answered here, from what its arrival read and from what this process
 * hears. A newer request on another instance reaches the request it overtook through the notice
 * source; the store has it should a notice be missed. A session is forgotten once it has been idle
 * for longer than both windows with no request in flight.
 */
export class VoiceSessionMemory {
  private readonly store: VoiceSessionMemoryStore;
  private readonly notices: VoiceSessionNoticeSource;
  private readonly windows: VoiceSessionMemoryWindows;
  private readonly retention: VoiceSessionRetention;
  private readonly logger?: Pick<AppLogger, "warn">;

  private readonly sessions = new Map<string, LocalSession>();
  /** This process's requests, by arrival number, until their settle has been written. */
  private readonly claims = new Map<string, VoiceTurnClaim>();
  private readonly contexts = new WeakMap<VoiceTurnClaim, ClaimContext>();
  /** Supersessions heard while an arrival here had no number yet, by the superseded number. */
  private readonly heldSupersessions = new Map<string, number>();
  private arriving = 0;

  private unsubscribe: (() => void) | null = null;
  private listening = false;
  /** Advances whenever notices may have been missed. */
  private noticeEpoch = 0;
  private catchUpRunning = false;
  private catchUpRequested = false;

  constructor(options: {
    store: VoiceSessionMemoryStore;
    notices: VoiceSessionNoticeSource;
    windows: VoiceSessionMemoryWindows;
    logger?: Pick<AppLogger, "warn">;
  }) {
    this.store = options.store;
    this.notices = options.notices;
    this.windows = options.windows;
    this.logger = options.logger;
    this.retention = {
      forgetAfterMs: Math.max(options.windows.replayWindowMs, options.windows.bridgeAfterMs),
      requestLifetimeMs: REQUEST_LIFETIME_MS,
    };
  }

  /**
   * Registers a request of the session, one store round trip; the request in flight before it is
   * superseded from now, on whichever instance it runs.
   */
  async arrive(session: VoiceSessionRef, now: number): Promise<VoiceTurnClaim> {
    const local = this.localSession(sessionKeyOf(session));
    local.arriving += 1;
    this.arriving += 1;
    this.subscribe();
    let heardFromIssue = false;
    let epochAtIssue = 0;
    let arrival: VoiceSessionArrival;
    try {
      arrival = await this.inOrder(local, () => {
        // Not waiting for the notice connection: when it is not listening yet, this request
        // catches up from the store once its number is known.
        heardFromIssue = this.listening;
        epochAtIssue = this.noticeEpoch;
        return this.store.arrive({ session, now, retention: this.retention });
      });
    } catch (error) {
      this.arrivalEnded(local);
      throw error;
    }

    const claim: VoiceTurnClaim = {
      sequence: arrival.sequence,
      supersededAt: this.heldSupersessions.get(arrival.sequence) ?? null,
      hungUpAt: null,
      outcomeAt: null,
      settled: false,
    };
    this.contexts.set(claim, { local, arrival, chatTurnRunning: false });
    local.claims.add(claim);
    this.claims.set(claim.sequence, claim);
    this.arrivalEnded(local);
    if (arrival.supersededSequence) {
      this.superseded(arrival.supersededSequence, now);
    }
    if (!heardFromIssue || epochAtIssue !== this.noticeEpoch) {
      // A newer request may have been announced while nothing listened.
      this.requestCatchUp();
    }
    return claim;
  }

  /**
   * Ends the request's hold on the session. `exchange` is what the conversation now keeps of the
   * turn; undefined when it keeps nothing, so the exchange before it stays the newest. Written off
   * the turn's path, before this process's next request of the session arrives.
   */
  settle(claim: VoiceTurnClaim, now: number, exchange: VoiceExchange | undefined): void {
    const context = this.contexts.get(claim);
    if (!context || claim.settled) {
      return;
    }
    claim.settled = true;
    context.chatTurnRunning = false;
    const remembered: RememberedVoiceExchange | null = exchange
      ? {
          utteranceDigest: utteranceDigest(exchange.utterance),
          conversationId: exchange.conversationId,
          reply: exchange.reply,
          spoken: exchange.spoken,
          cutOffAt: exchange.cutOffAt,
        }
      : null;
    void this.inOrder(context.local, () => this.store.settle({
      sessionId: context.arrival.sessionId,
      sequence: claim.sequence,
      now,
      cutOff: cutOffAt(claim) !== null,
      exchange: remembered,
      retention: this.retention,
    }))
      .catch((error: unknown) => this.warn("voice_session_settle_failed", error))
      .finally(() => this.forget(claim, context.local));
  }

  chatTurnStarted(claim: VoiceTurnClaim): void {
    const context = this.contexts.get(claim);
    if (context) {
      context.chatTurnRunning = true;
    }
  }

  chatTurnEnded(claim: VoiceTurnClaim): void {
    const context = this.contexts.get(claim);
    if (context) {
      context.chatTurnRunning = false;
    }
  }

  /** Remembers the bridge line for the session's next requests, written off the turn's path. */
  bridgeSpoken(claim: VoiceTurnClaim, now: number): void {
    const context = this.contexts.get(claim);
    if (!context) {
      return;
    }
    this.inOrder(context.local, () => this.store.bridgeSpoken({ sessionId: context.arrival.sessionId, sequence: claim.sequence, at: now }))
      .catch((error: unknown) => this.warn("voice_session_bridge_failed", error));
  }

  /**
   * Whether the request may speak its bridge line now: not once a newer request owns the session,
   * and not while a bridge from a turn that lost its caller is fresher than the bridge delay.
   */
  mayBridge(claim: VoiceTurnClaim, now: number): boolean {
    if (claim.supersededAt !== null) {
      return false;
    }
    const context = this.contexts.get(claim);
    const last = context ? this.lastBridgeOf(context) : null;
    return !(last && last.sequence !== claim.sequence && last.cutOff && now - last.at < this.windows.bridgeAfterMs);
  }

  /**
   * The stored answer to speak again for `utterance`: the session's newest exchange asked the
   * same, has an answer, lost its caller within the replay window, and no chat turn is running.
   */
  replayFor(claim: VoiceTurnClaim, utterance: string, now: number): ReplayableVoiceExchange | null {
    const context = this.contexts.get(claim);
    const exchange = context?.arrival.lastExchange?.exchange;
    if (!context || !exchange?.reply || exchange.cutOffAt === null || this.chatTurnMayBeRunning(context)) {
      return null;
    }
    const withinWindow = now - exchange.cutOffAt <= this.windows.replayWindowMs;
    return withinWindow && exchange.utteranceDigest === utteranceDigest(utterance)
      ? { conversationId: exchange.conversationId, reply: exchange.reply }
      : null;
  }

  /**
   * Reserves the newest exchange's reply as far as the caller heard it, while the vendor reports it
   * cut short and no note of it is recorded or being written, on any instance; null when the report
   * is no strict prefix of what was spoken.
   */
  async reserveInterruption(claim: VoiceTurnClaim, heardUntil: string): Promise<VoiceReplyInterruptionReservation | null> {
    const context = this.contexts.get(claim);
    const last = context?.arrival.lastExchange;
    const { reply, spoken, conversationId } = last?.exchange ?? {};
    if (!context || !last || last.note !== "none" || !reply || !spoken || !conversationId) {
      return null;
    }
    const whole = spoken.bridge === null ? spoken.reply : `${spoken.bridge} ${spoken.reply}`;
    const heard = heardPrefixLength(whole, heardUntil);
    if (heard === null) {
      return null;
    }
    const note = { sessionId: context.arrival.sessionId, exchangeSequence: last.sequence };
    try {
      if (!(await this.store.claimInterruptionNote(note))) {
        return null;
      }
    } catch (error) {
      this.warn("voice_session_note_claim_failed", error);
      return null;
    }
    const release = (recorded: boolean): void => {
      this.store.releaseInterruptionNote({ ...note, recorded })
        .catch((error: unknown) => this.warn("voice_session_note_release_failed", error));
    };
    const beforeReply = spoken.bridge === null ? 0 : spokenLength(spoken.bridge) + 1;
    return {
      interruption: {
        conversationId,
        assistantMessageId: reply.messageId,
        heardCharacterCount: Math.max(0, heard - beforeReply),
        spokenCharacterCount: spokenLength(spoken.reply),
      },
      recorded: () => release(true),
      failed: () => release(false),
    };
  }

  /**
   * The session's last bridge line as of this request's arrival. Whether its request lost its caller
   * is known exactly when that request runs here; one that ran elsewhere and was still in flight then
   * lost it, since this request or an earlier one overtook it.
   */
  private lastBridgeOf(context: ClaimContext): { sequence: string; at: number; cutOff: boolean } | null {
    const remembered = context.arrival.lastBridge;
    if (!remembered) {
      return null;
    }
    const claimHere = this.claims.get(remembered.sequence);
    const cutOff = claimHere ? cutOffAt(claimHere) !== null : remembered.cutOff ?? true;
    return { sequence: remembered.sequence, at: remembered.at, cutOff };
  }

  /**
   * Whether another request of the session may be running a chat turn. This process knows its own
   * requests; one in flight on another instance counts as running one.
   */
  private chatTurnMayBeRunning(context: ClaimContext): boolean {
    return context.arrival.inFlightSequences.some((sequence) => {
      const claimHere = this.claims.get(sequence);
      if (!claimHere) {
        return true;
      }
      return !claimHere.settled && this.contexts.get(claimHere)?.chatTurnRunning === true;
    });
  }

  /** A newer request arrived at `at`; the request `sequence` is superseded wherever it runs. */
  private superseded(sequence: string, at: number): void {
    const claim = this.claims.get(sequence);
    if (claim) {
      if (!claim.settled) {
        claim.supersededAt ??= at;
      }
      return;
    }
    if (this.arriving > 0 && !this.heldSupersessions.has(sequence)) {
      // It may be an arrival here whose number is still on its way back.
      this.heldSupersessions.set(sequence, at);
    }
  }

  /**
   * Reads back the supersessions announced while nothing listened, for this process's requests in
   * flight that have heard of none, retrying with backoff while any remain. One catch-up runs at a
   * time; a request during it runs it again.
   */
  private requestCatchUp(): void {
    if (!this.listening) {
      // The next `listening` catches up on every request in flight here.
      return;
    }
    if (this.catchUpRunning) {
      this.catchUpRequested = true;
      return;
    }
    void this.runCatchUp();
  }

  private async runCatchUp(): Promise<void> {
    this.catchUpRunning = true;
    let failures = 0;
    try {
      for (;;) {
        this.catchUpRequested = false;
        const sequences = [...this.claims.values()]
          .filter((claim) => !claim.settled && claim.supersededAt === null)
          .map((claim) => claim.sequence);
        if (sequences.length === 0 || !this.listening) {
          return;
        }
        try {
          for (const [sequence, at] of await this.store.supersededAt(sequences)) {
            this.superseded(sequence, at);
          }
          failures = 0;
          if (!this.catchUpRequested) {
            return;
          }
        } catch (error) {
          if (failures === 0) {
            this.warn("voice_session_catch_up_failed", error);
          }
          await sleep(Math.min(CATCH_UP_RETRY_MAX_MS, CATCH_UP_RETRY_INITIAL_MS * 2 ** failures));
          failures += 1;
        }
      }
    } finally {
      this.catchUpRunning = false;
    }
  }

  private onListening(): void {
    this.listening = true;
    // Announcements made while nothing listened are lost; the store has what they said.
    this.requestCatchUp();
  }

  private onInterrupted(): void {
    this.listening = false;
    this.noticeEpoch += 1;
  }

  private subscribe(): void {
    if (this.unsubscribe) {
      return;
    }
    this.unsubscribe = this.notices.subscribe({
      superseded: ({ sequence, at }) => this.superseded(sequence, at),
      listening: () => this.onListening(),
      interrupted: () => this.onInterrupted(),
    });
  }

  /** Stops listening once no request of this process is arriving or in flight. */
  private releaseSubscriptionWhenIdle(): void {
    if (this.arriving > 0 || this.claims.size > 0 || !this.unsubscribe) {
      return;
    }
    this.unsubscribe();
    this.unsubscribe = null;
    this.onInterrupted();
  }

  private localSession(key: string): LocalSession {
    let local = this.sessions.get(key);
    if (!local) {
      local = { key, claims: new Set(), arriving: 0, tail: Promise.resolve() };
      this.sessions.set(key, local);
    }
    return local;
  }

  private inOrder<T>(local: LocalSession, write: () => Promise<T>): Promise<T> {
    const written = local.tail.then(write);
    local.tail = written.then(() => undefined, () => undefined);
    return written;
  }

  private arrivalEnded(local: LocalSession): void {
    local.arriving -= 1;
    this.arriving -= 1;
    if (this.arriving === 0) {
      this.heldSupersessions.clear();
    }
    this.dropWhenIdle(local);
  }

  /** Forgets a settled request once its settle was written; no later arrival here lists it in flight. */
  private forget(claim: VoiceTurnClaim, local: LocalSession): void {
    this.claims.delete(claim.sequence);
    local.claims.delete(claim);
    this.dropWhenIdle(local);
  }

  private dropWhenIdle(local: LocalSession): void {
    if (local.arriving === 0 && local.claims.size === 0 && this.sessions.get(local.key) === local) {
      this.sessions.delete(local.key);
    }
    this.releaseSubscriptionWhenIdle();
  }

  private warn(event: string, error: unknown): void {
    this.logger?.warn(
      { event, errorType: error instanceof Error ? error.name : typeof error },
      "Voice session memory degraded",
    );
  }
}
