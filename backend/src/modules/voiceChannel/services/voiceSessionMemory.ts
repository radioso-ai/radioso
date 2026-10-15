import { createHash, randomUUID } from "node:crypto";

import type { AppLogger } from "../../../shared/observability/logger.js";
import type { VoiceSessionRef } from "../domain.js";
import { heardPrefixLength, spokenLength } from "./speechText.js";

/** One request's place in its session, from its arrival until its turn ends. */
export interface VoiceTurnClaim {
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

/** What the store held for the session when a request arrived, and the request's place in it. */
export interface VoiceSessionArrival {
  /** The session's durable memory, which the request's later writes address. */
  sessionId: string;
  /** Arrival number: rises in arrival order across every instance that serves the session. */
  sequence: string;
  /** The session's other requests still in flight, on any instance. */
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
  /** A claim on an interruption note older than this may be taken over: its owner crashed. */
  noteClaimLifetimeMs: number;
}

/**
 * Where the instances serving a session see each other's requests. Every call stands on its own:
 * arrivals of one instance are made in order, and nothing else waits for anything.
 */
export interface VoiceSessionMemoryStore {
  /**
   * Registers a request with the next arrival number, on the store's clock, and marks the request in
   * flight before it overtaken by this instance; that request's instance is told. The session's
   * exchange is forgotten first when the session has been idle past `forgetAfterMs` with nothing in
   * flight.
   */
  arrive(input: { session: VoiceSessionRef; instanceId: string; retention: VoiceSessionRetention }): Promise<VoiceSessionArrival>;
  /**
   * Ends a request: records its exchange unless a newer one is recorded, and whether it lost its
   * caller when it spoke the session's last bridge line. Also deletes forgotten sessions.
   */
  settle(input: {
    sessionId: string;
    sequence: string;
    cutOff: boolean;
    exchange: RememberedVoiceExchange | null;
    retention: VoiceSessionRetention;
  }): Promise<void>;
  /**
   * Records the request's bridge line while it is the session's newest request; false, and the
   * line must not be spoken, once any newer request arrived.
   */
  claimBridge(input: { sessionId: string; sequence: string }): Promise<boolean>;
  /** Takes the exchange's interruption note for `owner`; false while it is recorded or another owner's claim is live. */
  claimInterruptionNote(input: {
    sessionId: string;
    exchangeSequence: string;
    owner: string;
    retention: VoiceSessionRetention;
  }): Promise<boolean>;
  /** Marks `owner`'s claim recorded, or hands it back so a later report writes it. */
  releaseInterruptionNote(input: { sessionId: string; exchangeSequence: string; owner: string; recorded: boolean }): Promise<void>;
  /** When each of these requests was overtaken, for the ones a newer request overtook. */
  supersededAt(requests: Array<{ sessionId: string; sequence: string }>): Promise<Map<string, number>>;
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
/** An interruption note claimed this long ago and never released was abandoned. */
const NOTE_CLAIM_LIFETIME_MS = 60_000;

/** A failed catch-up is retried after this delay, doubling up to the maximum. */
const CATCH_UP_RETRY_INITIAL_MS = 250;
const CATCH_UP_RETRY_MAX_MS = 5_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms).unref();
});

const noop = (): void => undefined;

/** The last bridge line as this process knows it: spoken here (`claim`), or read from the store. */
interface KnownBridge {
  sequence: string;
  at: number;
  claim: VoiceTurnClaim | null;
  /** For a bridge read from the store: whether its request lost its caller; null while in flight. */
  cutOff: boolean | null;
}

interface KnownExchange {
  sequence: string;
  exchange: RememberedVoiceExchange;
  note: VoiceInterruptionNoteState;
  /** While `pending`: which reservation of this process holds the note, and since when. */
  noteHolder: { owner: string; since: number } | null;
}

/** What this process remembers of a session between its requests. */
interface SessionState {
  newest: VoiceTurnClaim | null;
  /** Requests not yet settled. */
  open: number;
  /** Chat turns still running for the session's requests. */
  chatTurns: number;
  lastBridge: KnownBridge | null;
  lastExchange: KnownExchange | null;
  touchedAt: number;
  /**
   * This process's requests of the session, by arrival number, until a request has settled in the
   * store and every arrival that might still list it in flight has been read.
   */
  readonly requests: Map<string, VoiceTurnClaim>;
  /** This process's arrivals of the session, so the store numbers them in call order. */
  arrivals: Promise<unknown>;
}

interface ClaimContext {
  readonly state: SessionState;
  readonly registration: Promise<void>;
  arrival: VoiceSessionArrival | null;
  /** A request of the session another instance runs was in flight as this one arrived. */
  inFlightElsewhere: boolean;
}

const sessionKeyOf = (session: VoiceSessionRef): string =>
  JSON.stringify([session.workspaceId, session.agentId, session.vendor, session.sessionKey]);

/** The caller's words, whitespace aside, as a digest: equal utterances share one. */
const utteranceDigest = (utterance: string): string =>
  createHash("sha256").update(utterance.replace(/\s+/gu, " ").trim()).digest("base64url");

const isNewer = (left: string, right: string): boolean => BigInt(left) > BigInt(right);

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
 * What each voice session remembers between its requests: which request is the newest (it
 * supersedes the ones before it), when a superseded turn last spoke a bridge line, and the last
 * exchange a re-request may replay or report as interrupted.
 *
 * Requests this process runs are remembered here, synchronously and exactly; a session is forgotten
 * once it has been idle for longer than both windows with nothing in flight. The store is how the
 * instances that share a session see each other: each request registers there as it arrives, one
 * round trip, and reads what other instances' requests left; a newer request on another instance
 * reaches the one it overtook through the notice source, and the store has it should a notice be
 * missed. A bridge line is claimed in the store before it is spoken, so a request another instance
 * overtook stays silent.
 */
export class VoiceSessionMemory {
  private readonly store: VoiceSessionMemoryStore;
  private readonly notices: VoiceSessionNoticeSource;
  private readonly windows: VoiceSessionMemoryWindows;
  private readonly retention: VoiceSessionRetention;
  private readonly retainMs: number;
  private readonly instanceId: string;
  private readonly logger?: Pick<AppLogger, "warn">;

  private readonly sessions = new Map<string, SessionState>();
  private readonly contexts = new WeakMap<VoiceTurnClaim, ClaimContext>();
  /** This process's unsettled requests, by arrival number, which notices and catch-ups address. */
  private readonly unsettled = new Map<string, VoiceTurnClaim>();
  /** Supersessions heard while an arrival here had no number yet, by the superseded number. */
  private readonly heldSupersessions = new Map<string, number>();
  private registering = 0;

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
    /** Names this process's requests in the store; one per process. */
    instanceId?: string;
    logger?: Pick<AppLogger, "warn">;
  }) {
    this.store = options.store;
    this.notices = options.notices;
    this.windows = options.windows;
    this.instanceId = options.instanceId ?? randomUUID();
    this.logger = options.logger;
    this.retainMs = Math.max(options.windows.replayWindowMs, options.windows.bridgeAfterMs);
    this.retention = {
      forgetAfterMs: this.retainMs,
      requestLifetimeMs: REQUEST_LIFETIME_MS,
      noteClaimLifetimeMs: NOTE_CLAIM_LIFETIME_MS,
    };
  }

  /**
   * Registers a request of the session; the request in flight before it is superseded from now.
   * The request in flight here is marked at once; `registered` resolves once every instance can see
   * the request, one store round trip later.
   */
  arrive(session: VoiceSessionRef, now: number): VoiceTurnClaim {
    this.forgetIdle(now);
    const state = this.stateOf(sessionKeyOf(session), now);
    const previous = state.newest;
    if (previous && !previous.settled) {
      previous.supersededAt ??= now;
    }
    const claim: VoiceTurnClaim = { supersededAt: null, hungUpAt: null, outcomeAt: null, settled: false };
    state.newest = claim;
    state.open += 1;
    this.registering += 1;
    this.subscribe();
    const registration = this.register(session, state, claim);
    // A failed registration fails the turn that awaits it; nothing else waits on it.
    registration.catch(noop);
    this.contexts.set(claim, { state, registration, arrival: null, inFlightElsewhere: false });
    return claim;
  }

  /** Resolves once the request is registered in the store; rejects when the store refused it. */
  registered(claim: VoiceTurnClaim): Promise<void> {
    return this.contexts.get(claim)?.registration ?? Promise.resolve();
  }

  /**
   * Ends the request's hold on the session. `exchange` is what the conversation now keeps of the
   * turn; undefined when it keeps nothing, so the exchange before it stays the newest. Applied here
   * at once; the returned promise resolves once the store has it, and never rejects.
   */
  settle(claim: VoiceTurnClaim, now: number, exchange: VoiceExchange | undefined): Promise<void> {
    const context = this.contexts.get(claim);
    if (!context || claim.settled) {
      return Promise.resolve();
    }
    const { state } = context;
    claim.settled = true;
    state.open = Math.max(0, state.open - 1);
    state.touchedAt = now;
    if (state.newest === claim) {
      state.newest = null;
    }
    const { arrival } = context;
    if (!arrival) {
      // Never registered: nothing of it reached the store.
      return Promise.resolve();
    }
    const { sequence } = arrival;
    this.unsettled.delete(sequence);
    const remembered: RememberedVoiceExchange | null = exchange
      ? {
          utteranceDigest: utteranceDigest(exchange.utterance),
          conversationId: exchange.conversationId,
          reply: exchange.reply,
          spoken: exchange.spoken,
          cutOffAt: exchange.cutOffAt,
        }
      : null;
    if (remembered && (state.lastExchange === null || isNewer(sequence, state.lastExchange.sequence))) {
      state.lastExchange = { sequence, exchange: remembered, note: "none", noteHolder: null };
    }
    this.releaseSubscriptionWhenIdle();
    return this.store.settle({
      sessionId: arrival.sessionId,
      sequence,
      cutOff: cutOffAt(claim) !== null,
      exchange: remembered,
      retention: this.retention,
    })
      .catch((error: unknown) => this.warn("voice_session_settle_failed", error))
      .finally(() => {
        // Arrivals made from now on read the request settled; the ones already on their way may
        // still list it in flight, so it stays known here until they are read.
        void state.arrivals.then(() => {
          if (state.requests.get(sequence) === claim) {
            state.requests.delete(sequence);
          }
        });
      });
  }

  /** How many of this process's requests the memory still holds, settled or not. */
  heldRequestCount(): number {
    let held = 0;
    for (const state of this.sessions.values()) {
      held += state.requests.size;
    }
    return held;
  }

  chatTurnStarted(claim: VoiceTurnClaim, now: number): void {
    const state = this.touched(claim, now);
    if (state) {
      state.chatTurns += 1;
    }
  }

  chatTurnEnded(claim: VoiceTurnClaim, now: number): void {
    const state = this.touched(claim, now);
    if (state) {
      state.chatTurns = Math.max(0, state.chatTurns - 1);
    }
  }

  bridgeSpoken(claim: VoiceTurnClaim, now: number): void {
    const context = this.contexts.get(claim);
    const state = this.touched(claim, now);
    if (state && context?.arrival) {
      state.lastBridge = { sequence: context.arrival.sequence, at: now, claim, cutOff: null };
    }
  }

  /**
   * Whether the request may speak its bridge line now: not once a newer request owns the session,
   * and not while a bridge from a turn that lost its caller is fresher than the bridge delay.
   */
  mayBridge(claim: VoiceTurnClaim, now: number): boolean {
    if (claim.supersededAt !== null) {
      return false;
    }
    const last = this.contexts.get(claim)?.state.lastBridge;
    if (!last || last.claim === claim) {
      return true;
    }
    const cutOff = last.claim ? cutOffAt(last.claim) !== null : last.cutOff ?? true;
    return !(cutOff && now - last.at < this.windows.bridgeAfterMs);
  }

  /**
   * Claims the bridge line, asked once `mayBridge` allowed it, right before it is spoken. Here it
   * is decided at once: only this process's newest request of the session may take the line, and
   * taking it holds the next request's bridge back as a spoken one would. The store then refuses it
   * when any newer request arrived meanwhile, on this instance or another, and the line stays
   * unspoken. When the store cannot be reached, the line is spoken.
   */
  async claimBridge(claim: VoiceTurnClaim, now: number): Promise<boolean> {
    const context = this.contexts.get(claim);
    const arrival = context?.arrival;
    if (!context || !arrival) {
      return true;
    }
    const { state } = context;
    if (state.newest !== claim || claim.supersededAt !== null) {
      return false;
    }
    const before = state.lastBridge;
    const taken: KnownBridge = { sequence: arrival.sequence, at: now, claim, cutOff: null };
    state.lastBridge = taken;
    let claimed: boolean;
    try {
      claimed = await this.store.claimBridge({ sessionId: arrival.sessionId, sequence: arrival.sequence });
    } catch (error) {
      this.warn("voice_session_bridge_claim_failed", error);
      return true;
    }
    if (!claimed && state.lastBridge === taken) {
      state.lastBridge = before;
    }
    return claimed;
  }

  /**
   * The stored answer to speak again for `utterance`: the session's newest exchange asked the
   * same, has an answer, lost its caller within the replay window, and no chat turn is running. A
   * request of the session in flight on another instance counts as running one.
   */
  replayFor(claim: VoiceTurnClaim, utterance: string, now: number): ReplayableVoiceExchange | null {
    const context = this.contexts.get(claim);
    const exchange = context?.state.lastExchange?.exchange;
    if (!context || !exchange?.reply || exchange.cutOffAt === null || context.state.chatTurns > 0 || context.inFlightElsewhere) {
      return null;
    }
    const withinWindow = now - exchange.cutOffAt <= this.windows.replayWindowMs;
    return withinWindow && exchange.utteranceDigest === utteranceDigest(utterance)
      ? { conversationId: exchange.conversationId, reply: exchange.reply }
      : null;
  }

  /**
   * Reserves the newest exchange's reply as far as the caller heard it, while the vendor reports it
   * cut short and no note of it is recorded or being written; null when the report is no strict
   * prefix of what was spoken. Held here at once, then claimed in the store, so the note is written
   * once whichever instances the reports reach; a reservation never recorded nor handed back lapses
   * after a minute, here and in the store.
   */
  async reserveInterruption(
    claim: VoiceTurnClaim,
    heardUntil: string,
    now: number,
  ): Promise<VoiceReplyInterruptionReservation | null> {
    const context = this.contexts.get(claim);
    const last = context?.state.lastExchange;
    const { reply, spoken, conversationId } = last?.exchange ?? {};
    const lapsed = last?.note === "pending" && last.noteHolder !== null && now - last.noteHolder.since > NOTE_CLAIM_LIFETIME_MS;
    if (!context?.arrival || !last || (last.note !== "none" && !lapsed) || !reply || !spoken || !conversationId) {
      return null;
    }
    const whole = spoken.bridge === null ? spoken.reply : `${spoken.bridge} ${spoken.reply}`;
    const heard = heardPrefixLength(whole, heardUntil);
    if (heard === null) {
      return null;
    }
    const note = { sessionId: context.arrival.sessionId, exchangeSequence: last.sequence, owner: randomUUID() };
    last.note = "pending";
    last.noteHolder = { owner: note.owner, since: now };
    /** Ends this reservation's hold here, unless a later reservation took the note over. */
    const letGo = (state: VoiceInterruptionNoteState): void => {
      if (last.noteHolder?.owner === note.owner) {
        last.note = state;
        last.noteHolder = null;
      }
    };
    let claimed = false;
    try {
      claimed = await this.store.claimInterruptionNote({ ...note, retention: this.retention });
    } catch (error) {
      this.warn("voice_session_note_claim_failed", error);
    }
    if (!claimed) {
      letGo("none");
      return null;
    }
    const release = (recorded: boolean): void => {
      letGo(recorded ? "recorded" : "none");
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

  private async register(session: VoiceSessionRef, state: SessionState, claim: VoiceTurnClaim): Promise<void> {
    let heardFromIssue = false;
    let epochAtIssue = 0;
    const previousArrivals = state.arrivals;
    // Only this session's earlier arrivals here come first: the store numbers them in call order.
    const arriving = previousArrivals.then(() => {
      heardFromIssue = this.listening;
      epochAtIssue = this.noticeEpoch;
      return this.store.arrive({ session, instanceId: this.instanceId, retention: this.retention });
    });
    state.arrivals = arriving.catch(noop);
    try {
      let arrival: VoiceSessionArrival;
      try {
        arrival = await arriving;
      } catch (error) {
        this.settle(claim, state.touchedAt, undefined).catch(noop);
        throw error;
      }
      const context = this.contexts.get(claim);
      if (context) {
        context.arrival = arrival;
        // Read now, while every request of this process the arrival may list is still known here.
        context.inFlightElsewhere = arrival.inFlightSequences.some((sequence) => !state.requests.has(sequence));
      }
      state.requests.set(arrival.sequence, claim);
      if (!claim.settled) {
        this.unsettled.set(arrival.sequence, claim);
        const heldAt = this.heldSupersessions.get(arrival.sequence);
        if (heldAt !== undefined) {
          claim.supersededAt ??= heldAt;
        }
      }
      this.learnFrom(state, arrival);
      if (!heardFromIssue || epochAtIssue !== this.noticeEpoch) {
        // A newer request may have been announced while nothing listened.
        this.requestCatchUp();
      }
    } finally {
      this.registering -= 1;
      if (this.registering === 0) {
        this.heldSupersessions.clear();
      }
      this.releaseSubscriptionWhenIdle();
    }
  }

  /** Takes in what other instances' requests left that this process has not seen. */
  private learnFrom(state: SessionState, arrival: VoiceSessionArrival): void {
    const bridge = arrival.lastBridge;
    if (bridge && (state.lastBridge === null || isNewer(bridge.sequence, state.lastBridge.sequence))) {
      state.lastBridge = { ...bridge, claim: state.requests.get(bridge.sequence) ?? null };
    }
    const exchange = arrival.lastExchange;
    if (!exchange) {
      return;
    }
    // `pending` here means this process is writing the note; another instance's claim is the
    // store's to arbitrate when this one tries.
    const note: VoiceInterruptionNoteState = exchange.note === "recorded" ? "recorded" : "none";
    if (state.lastExchange === null || isNewer(exchange.sequence, state.lastExchange.sequence)) {
      state.lastExchange = { sequence: exchange.sequence, exchange: exchange.exchange, note, noteHolder: null };
    } else if (state.lastExchange.sequence === exchange.sequence && note === "recorded") {
      state.lastExchange.note = note;
      state.lastExchange.noteHolder = null;
    }
  }

  /** A newer request arrived at `at`; the request `sequence` is superseded wherever it runs. */
  private superseded(sequence: string, at: number): void {
    const claim = this.unsettled.get(sequence);
    if (claim) {
      claim.supersededAt ??= at;
      return;
    }
    if (this.registering > 0 && !this.heldSupersessions.has(sequence)) {
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
        const requests = [...this.unsettled.entries()]
          .filter(([, claim]) => claim.supersededAt === null)
          .flatMap(([sequence, claim]) => {
            const sessionId = this.contexts.get(claim)?.arrival?.sessionId;
            return sessionId ? [{ sessionId, sequence }] : [];
          });
        if (requests.length === 0 || !this.listening) {
          return;
        }
        try {
          for (const [sequence, at] of await this.store.supersededAt(requests)) {
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
    if (this.registering > 0 || this.unsettled.size > 0 || !this.unsubscribe) {
      return;
    }
    this.unsubscribe();
    this.unsubscribe = null;
    this.onInterrupted();
  }

  private touched(claim: VoiceTurnClaim, now: number): SessionState | null {
    const state = this.contexts.get(claim)?.state;
    if (state) {
      state.touchedAt = now;
    }
    return state ?? null;
  }

  private stateOf(sessionKey: string, now: number): SessionState {
    let state = this.sessions.get(sessionKey);
    if (!state) {
      state = {
        newest: null,
        open: 0,
        chatTurns: 0,
        lastBridge: null,
        lastExchange: null,
        touchedAt: now,
        requests: new Map(),
        arrivals: Promise.resolve(),
      };
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

  private warn(event: string, error: unknown): void {
    this.logger?.warn(
      { event, errorType: error instanceof Error ? error.name : typeof error },
      "Voice session memory degraded",
    );
  }
}
