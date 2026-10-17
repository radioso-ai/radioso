import type {
  ChatStreamEvent,
  ChatTurnHandoffReason,
  ConversationTurnSupersession,
  DeliveredReplyPart,
  DeliveredReplyReader,
  OperatorReplySpeechClaims,
} from "../../chat/contracts/index.js";
import { errorClassOf } from "../../../shared/observability/errorClass.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import { VOICE_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import { VOICE_SOURCE_CHANNEL } from "../../../shared/domain/conversationSource.js";
import type { AgentVoiceSettings } from "../../agents/public.js";
import {
  VOICE_REPLY_INTERRUPTED_EVENT,
  VoiceTurnIncompleteError,
  type VoiceChannelContext,
  type VoiceSessionRef,
  type VoiceSessionStartLookup,
  type VoiceTurnEvent,
  type VoiceTurnInput,
  type VoiceTurnOutcome,
  type VoiceTurnPort,
} from "../domain.js";
import { chooseVoiceTurnLines, resolveVoiceTurnLocale } from "./voiceLines.js";
import {
  recordVoiceBridgeDue,
  recordVoiceFirstSpeech,
  recordVoiceReplyInterrupted,
  recordVoiceTurnLimit,
  recordVoiceTurnOutcome,
  recordVoiceTurnReplayed,
  recordVoiceTurnSuperseded,
  type VoiceTurnMetricsSink,
} from "./voiceTurnMetrics.js";
import { deriveVoiceTurnOutcome } from "./voiceTurnOutcome.js";
import {
  applyVoiceTurnPolicy,
  withoutPhaseMarkers,
  type VoiceReplyEvent,
  type VoiceTurnDrain,
  type VoiceTurnPhase,
  type VoiceTurnPolicy,
} from "./voiceTurnPolicy.js";
import { OperatorReplySpeaker, type ClaimedOperatorReply, type OperatorReplySpeakerDependencies } from "./operatorReplySpeaker.js";
import { createSentenceCutter, splitCompleteSentences } from "./speechSegmenter.js";
import { hasSpokenWords, spokenLength, writtenLengthSpokenAs } from "./speechText.js";
import { heardSpeechOf, type HeardSpeech, type ReachedSpeech } from "./heardSpeech.js";
import {
  cutOffAt,
  VoiceSessionMemory,
  type ReplayableVoiceExchange,
  type VoiceExchange,
  type VoiceStoredReply,
  type VoiceTurnClaim,
} from "./voiceSessionMemory.js";

/** Where a voice session's conversation is remembered. */
export interface VoiceSessionStore {
  findConversationId(session: VoiceSessionRef): Promise<string | null>;
  /** Binds the session unless it is bound already; returns the conversation it is bound to. */
  bind(session: VoiceSessionRef, conversationId: string): Promise<string>;
}

export interface VoiceChatTurnRequest {
  workspaceId: string;
  agentId: string;
  /** Absent on a session's first turn: the chat turn starts the conversation. */
  conversationId?: string;
  message: string;
  sourceChannel: typeof VOICE_SOURCE_CHANNEL;
  channelContext: VoiceChannelContext;
  /**
   * A newer utterance of the session overtakes this turn even mid-reply, and one that overtakes it
   * before its reply starts replaces it, so the conversation keeps no user message for it.
   */
  supersession: Extract<ConversationTurnSupersession, "latest_input_wins">;
  /**
   * Asked by chat when a newer utterance cuts the turn off after its reply started: the answer's
   * sentences that reached the runtime before the turn lost its caller, which chat keeps as the
   * turn's reply, marked cut short.
   */
  deliveredReply: DeliveredReplyReader;
  /**
   * On a session's first turn, when Radioso started the session for a website visitor: that
   * visitor's grouping key, so the new conversation joins the visitor the embed's own chat does.
   */
  visitorKey?: string;
  signal: AbortSignal;
}

/** The streaming chat turn every other channel runs. */
interface VoiceChatPort {
  streamTurn(request: VoiceChatTurnRequest): AsyncIterable<ChatStreamEvent>;
}

/** What a voice turn needs from the agent's settings. */
interface VoiceAgentProfile {
  voice: AgentVoiceSettings;
  /** The agent's default language tag, which a turn speaks in when the request names none. */
  defaultLocale: string | null;
}

interface VoiceAgentProfileSource {
  /** Null when the agent no longer exists; the turn then runs without the policy and fails in chat. */
  findVoiceProfile(agent: Pick<VoiceSessionRef, "workspaceId" | "agentId">): Promise<VoiceAgentProfile | null>;
}

interface VoiceRoutineStateSource {
  /** Whether a routine is mid-flight in the conversation. */
  isRoutineActive(conversationId: string): Promise<boolean>;
}

interface VoiceConversationOwnershipSource {
  /** Whether a person owns the conversation, so chat answers the turn with its waiting message. */
  isHumanOwned(conversationId: string): Promise<boolean>;
}

interface VoiceTurnTiming {
  bridgeAfterMs: number;
  bridgeAfterComposingIdleMs: number;
  turnLimitMs: number;
  replayWindowMs: number;
}

/** Durable notes on a session's turns, keyed to their stored replies. Never the reply's text. */
export interface VoiceTurnNotes {
  /**
   * The vendor replayed a reply that had finished cut short: how much of it the caller heard. (A
   * reply cut off while it streamed is stored marked, and audited, by chat with its heard part.)
   */
  replyInterrupted(note: {
    workspaceId: string;
    conversationId: string;
    assistantMessageId: string;
    heardCharacterCount: number;
    spokenCharacterCount: number;
  }): Promise<void>;
  /** An identical re-request heard the stored reply again, without a new turn. */
  replyReplayed(note: { workspaceId: string; conversationId: string; assistantMessageId: string }): Promise<void>;
  /** A turn spoke a teammate's replies and completed, and they are recorded as spoken: by id only. */
  operatorRepliesSpoken(note: { workspaceId: string; conversationId: string; messageIds: string[] }): Promise<void>;
}

type ChatStatusStage = Extract<ChatStreamEvent, { type: "status" }>["stage"];

/** The chat stage each status event reports, as the phase the turn policy reads. */
const PHASE_OF_STAGE: Record<ChatStatusStage, VoiceTurnPhase> = {
  interpreting: "interpreting",
  searching: "searching",
  composing: "composing",
};

interface VoiceTurnServiceDependencies {
  sessions: VoiceSessionStore;
  chat: VoiceChatPort;
  agents: VoiceAgentProfileSource;
  routines: VoiceRoutineStateSource;
  ownership: VoiceConversationOwnershipSource;
  logger: Pick<AppLogger, "info" | "warn">;
  metrics?: VoiceTurnMetricsSink | null;
  notes?: VoiceTurnNotes;
  /** Chat's teammate replies the caller has not heard yet, the claims turns hold on them, and the id each turn claims under. */
  operatorReplies: { claims: OperatorReplySpeechClaims; newClaimTurnId: () => string };
  /** The visitor a Radioso-started session was started for; without it, first turns join no visitor. */
  starts?: VoiceSessionStartLookup;
  /** Overrides `VOICE_BEHAVIOR`; tests only. */
  timing?: VoiceTurnTiming;
  now?: () => number;
}

type VoiceTurnResult = "completed" | "replayed" | "superseded" | "abandoned" | "failed";

/** What the turn's one log record reports, and what the session remembers of it. */
interface VoiceTurnRecord {
  conversationId: string | null;
  speechPieceCount: number;
  result: VoiceTurnResult;
  /** Present when the agent's voice policy ran. */
  policy?: { bridged: boolean; turnLimitReached: boolean; fallbackSpoken: boolean };
  /** Chat reported progress, so it stored the turn's user message. */
  chatPrepared: boolean;
  /** Chat began the reply, so a newer utterance no longer replaces the user message. */
  chatReplied: boolean;
  /** The stored answer, once chat reports it: the whole reply, or the heard part of one cut off mid-stream. */
  reply: VoiceStoredReply | null;
  /** The answer as chat streamed it so far, before it was cut into speech. */
  written: string;
  /**
   * What left the turn for the caller: a teammate's replies, the bridge line, and every speech
   * piece of the turn's own answer, each in order. `reached`: how many of the teammate's pieces and
   * then the answer's, in that order, reached the runtime before the turn lost its caller (cut off
   * or hung up on); none on a response that is not streamed, which the runtime gets at the outcome.
   */
  spoken: { operatorReplies: string[]; bridge: string | null; speech: string[]; reached: number };
  /** The response streams its speech, so each piece reaches the runtime as it leaves. */
  streamsSpeech: boolean;
  /**
   * What the request that overtook this turn reported the caller heard of it: the runtime's own
   * record of what it played, cut where the caller spoke over it.
   */
  reportedHeard?: string;
  /** What chat was told reached the caller of a reply cut off mid-stream, once it asked. */
  deliveredPart: DeliveredReplyPart | null;
  /** The teammate replies the turn claims, speaks ahead of its answer, and settles. */
  operatorReplyClaims: OperatorReplySpeaker;
  /** The outcome the runtime received, once it left. */
  outcome: VoiceTurnOutcome | null;
  /** Why chat handed the conversation to a person on this turn; null when it did not. */
  handoffReason: ChatTurnHandoffReason | null;
  /** The reply still draining after the turn limit ended the turn's events; the turn ends with it. */
  drain?: Promise<VoiceTurnDrain>;
}

const emptyRecord = (operatorReplyClaims: OperatorReplySpeaker, streamsSpeech: boolean): VoiceTurnRecord => ({
  conversationId: null,
  speechPieceCount: 0,
  result: "abandoned",
  chatPrepared: false,
  chatReplied: false,
  reply: null,
  written: "",
  spoken: { operatorReplies: [], bridge: null, speech: [], reached: 0 },
  streamsSpeech,
  deliveredPart: null,
  operatorReplyClaims,
  outcome: null,
  handoffReason: null,
});

const CONTINUE_OUTCOME: VoiceTurnOutcome = { kind: "continue" };

/** How long a turn's audit note may take before it is reported as not recorded. */
const NOTE_TIMEOUT_MS = 5_000;

class VoiceTurnNoteTimeoutError extends Error {
  constructor() {
    super(`Voice turn note took longer than ${NOTE_TIMEOUT_MS} ms`);
    this.name = "VoiceTurnNoteTimeoutError";
  }
}

/** The note, or a timeout error once it has taken too long; the write itself goes on either way. */
const withinNoteTimeout = <T>(note: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new VoiceTurnNoteTimeoutError()), NOTE_TIMEOUT_MS);
  });
  return Promise.race([note, timeout]).finally(() => clearTimeout(timer));
};
const CONTINUE: VoiceTurnEvent = { type: "outcome", outcome: CONTINUE_OUTCOME };

/** The end of a whole reply as speech: its remaining sentences, then the tail, which is the last piece. */
function* lastSpeech(rest: { sentences: string[]; remainder: string }, record: VoiceTurnRecord): Generator<VoiceTurnEvent> {
  for (const text of rest.sentences) {
    record.speechPieceCount += 1;
    yield { type: "speech", text, last: false };
  }
  record.speechPieceCount += 1;
  yield { type: "speech", text: rest.remainder, last: true };
}

/** The speech that reached the runtime before the turn lost its caller, in order. */
const reachedSpeechOf = (record: VoiceTurnRecord): ReachedSpeech => {
  const operatorReplies = record.spoken.operatorReplies.slice(0, record.spoken.reached);
  return {
    operatorReplies,
    bridge: record.spoken.bridge,
    answer: record.policy?.fallbackSpoken ? [] : record.spoken.speech.slice(0, Math.max(0, record.spoken.reached - operatorReplies.length)),
  };
};

/**
 * How many pieces of the teammate replies the turn spoke its caller heard to their end: all of
 * them once the outcome reached the runtime before the turn lost its caller; else as far as the
 * request that overtook it reports the caller heard; else none, so the turn that cut in speaks
 * the replies whole.
 */
const operatorReplyPiecesHeard = (record: VoiceTurnRecord, claim: VoiceTurnClaim): number => {
  if (claim.outcomeAt !== null && cutOffAt(claim) === null) {
    return record.spoken.operatorReplies.length;
  }
  const reported = record.reportedHeard === undefined ? null : heardSpeechOf(reachedSpeechOf(record), record.reportedHeard);
  return reported?.operatorReplyPieces ?? 0;
};

/** A session's first turn in this process, until it binds the session or ends without binding it. */
interface FirstTurn {
  settled: Promise<void>;
  settle(): void;
}

/** What a turn starts from: the session's conversation, or the claim to start one. */
type SessionClaim =
  | { conversationId: string }
  | { conversationId: null; firstTurn: FirstTurn; visitorKey: string | null };

const createFirstTurn = (): FirstTurn => {
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => { settle = resolve; });
  return { settled, settle };
};

const sessionKeyOf = (session: VoiceSessionRef): string =>
  JSON.stringify([session.workspaceId, session.agentId, session.vendor, session.sessionKey]);

const channelContextFor = (input: VoiceTurnInput): VoiceChannelContext => ({
  provider: "voice",
  vendor: input.session.vendor,
  sessionKey: input.session.sessionKey,
  transport: input.transport,
});

/**
 * Runs one caller turn as a chat turn on the session's conversation and re-cuts the reply into
 * sentence-sized speech. The turn's governance, routines and persistence are the chat turn's own.
 */
export class VoiceTurnService implements VoiceTurnPort {
  private readonly now: () => number;
  private readonly timing: VoiceTurnTiming;
  /** Picks the next authored bridge line on each policy turn this process runs, whatever the session. */
  private policyTurns = 0;
  /**
   * In-process single flight for unbound sessions: a second first turn waits until the first one
   * binds the session, then joins its conversation. Turns on different instances can still race;
   * `bind` keeps the session on the first binding either way.
   */
  private readonly firstTurns = new Map<string, FirstTurn>();
  /** The newest request, the last bridge and the last exchange of each session, in this process. */
  private readonly memory: VoiceSessionMemory;
  /** What each turn's teammate replies are claimed, spoken and settled through. */
  private readonly operatorReplySpeaker: OperatorReplySpeakerDependencies;
  /** Each request's turn record, so a newer request of the session can settle the teammate replies of the one it overtook. */
  private readonly turnRecords = new WeakMap<VoiceTurnClaim, VoiceTurnRecord>();
  /** Agents already warned about a bridge line shorter than their runtime speaks on its own. */
  private readonly shortBridgeWarned = new Set<string>();

  constructor(private readonly dependencies: VoiceTurnServiceDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.timing = dependencies.timing ?? VOICE_BEHAVIOR;
    this.memory = new VoiceSessionMemory(this.timing);
    const { notes } = dependencies;
    this.operatorReplySpeaker = {
      replies: dependencies.operatorReplies,
      ...(notes ? { audit: (spoken: { workspaceId: string; conversationId: string; messageIds: string[] }) => notes.operatorRepliesSpoken(spoken) } : {}),
      withinTimeout: withinNoteTimeout,
      logger: dependencies.logger,
      metrics: dependencies.metrics,
    };
  }

  /**
   * The newest request of a session wins. One that arrives while an older one is still setting up
   * ends the older one before its chat turn starts; once both run as chat turns, the chat turn
   * registry cancels the older one, mid-reply if need be. An identical re-request for a reply that
   * lost its caller hears the stored answer again.
   */
  async *runTurn(input: VoiceTurnInput, signal: AbortSignal, hungUp?: AbortSignal): AsyncGenerator<VoiceTurnEvent> {
    const startedAt = this.now();
    const sessionKey = sessionKeyOf(input.session);
    const claim = this.memory.arrive(sessionKey, startedAt);
    const onHangUp = (): void => {
      claim.hungUpAt ??= this.now();
    };
    if (hungUp?.aborted) {
      onHangUp();
    } else {
      hungUp?.addEventListener("abort", onHangUp, { once: true });
    }
    const record = emptyRecord(new OperatorReplySpeaker(this.operatorReplySpeaker, input.session), input.streamsSpeech);
    this.turnRecords.set(claim, record);
    let failure: unknown;
    let firstTurn: FirstTurn | undefined;

    try {
      this.noteInterruptedReply(input, sessionKey, claim);
      const replay = this.memory.replayFor(sessionKey, input.utterance, startedAt);
      if (replay) {
        // The teammate's replies the caller has not heard come before the answer heard again.
        record.conversationId = replay.conversationId;
        const replies = await this.claimOperatorReplies(claim, record, replay.conversationId);
        if (claim.supersededAt !== null) {
          // Overtaken while claiming: the newer request owns the session, and the claim goes back.
          record.result = "superseded";
          record.outcome = CONTINUE_OUTCOME;
          yield CONTINUE;
          return;
        }
        yield { type: "conversation", conversationId: replay.conversationId };
        yield* this.operatorReplySpeech(replies, record, claim);
        yield* this.delivered(this.replayEvents(input, replay, record), record, claim, sessionKey);
        return;
      }

      const sessionClaim = await this.claimSession(input.session);
      if (sessionClaim.conversationId === null) {
        firstTurn = sessionClaim.firstTurn;
      } else {
        record.conversationId = sessionClaim.conversationId;
      }
      // No bridge line follows a teammate's reply: the caller has just heard someone speak.
      const mayBridge = (): boolean => record.spoken.operatorReplies.length === 0 && this.memory.mayBridge(sessionKey, claim, this.now());
      const [policy, replies] = claim.supersededAt === null
        ? await Promise.all([
            this.policyFor(input, sessionClaim.conversationId, startedAt, record, mayBridge),
            sessionClaim.conversationId ? this.claimOperatorReplies(claim, record, sessionClaim.conversationId) : [],
          ])
        : [null, []];
      if (claim.supersededAt !== null) {
        // A newer request of the session arrived while this one was setting up; it owns the turn,
        // and the replies this one claimed go back to pending as it settles.
        record.result = "superseded";
        record.outcome = CONTINUE_OUTCOME;
        yield CONTINUE;
        return;
      }
      if (sessionClaim.conversationId) {
        yield { type: "conversation", conversationId: sessionClaim.conversationId };
        yield* this.operatorReplySpeech(replies, record, claim);
      }
      const reply = this.replyEvents(input, sessionClaim, record, signal, sessionKey);
      yield* this.delivered(policy ? applyVoiceTurnPolicy(reply, policy) : withoutPhaseMarkers(reply), record, claim, sessionKey);
    } catch (error) {
      record.result = "failed";
      failure = error;
      throw error;
    } finally {
      hungUp?.removeEventListener("abort", onHangUp);
      // Whether the caller heard the teammate's replies is decided once the outcome has left, so
      // they settle now rather than after a reply the limit cut off has drained.
      const repliesSettled = record.operatorReplyClaims.settle(failure === undefined ? operatorReplyPiecesHeard(record, claim) : null);
      const finish = (): void => {
        const finishedAt = this.now();
        this.releaseFirstTurn(input.session, firstTurn);
        const exchange = this.exchangeOf(input, record, claim);
        this.memory.settle(sessionKey, claim, finishedAt, exchange);
        if (record.reportedHeard !== undefined && exchange?.reply && !exchange.reply.partial) {
          // A newer request reported this turn's whole reply cut short before the turn settled.
          this.reserveInterruptionNote(input, sessionKey, record.reportedHeard);
        }
        // The log names how many replies were recorded spoken, so it waits for the settling writes;
        // its duration is the turn's own.
        if (repliesSettled) {
          void repliesSettled.then(() => this.logTurn(input, record, startedAt, finishedAt, failure));
        } else {
          this.logTurn(input, record, startedAt, finishedAt, failure);
        }
      };
      // The events end with the outcome; a reply the limit cut off drains behind them, and the
      // turn is settled and logged once it has finished.
      if (record.drain && failure === undefined) {
        void record.drain.then((drained) => {
          if (drained.failed) {
            record.result = "failed";
            failure = drained.error;
          }
          finish();
        });
      } else {
        finish();
      }
    }
  }

  /** Passes the turn's events on, remembering what the caller could hear and when the outcome left. */
  private async *delivered(
    events: AsyncIterable<VoiceTurnEvent>,
    record: VoiceTurnRecord,
    claim: VoiceTurnClaim,
    sessionKey: string,
  ): AsyncGenerator<VoiceTurnEvent> {
    for await (const event of events) {
      if (event.type === "bridge") {
        this.memory.bridgeSpoken(sessionKey, claim, this.now());
        record.spoken.bridge = event.text;
      } else if (event.type === "speech") {
        this.handOver(record, claim);
        record.spoken.speech.push(event.text);
      } else if (event.type === "outcome") {
        claim.outcomeAt ??= this.now();
        record.outcome = event.outcome;
      }
      yield event;
    }
  }

  /**
   * Counts the speech piece leaving now as one that reached the runtime, when the response streams
   * it and the turn still has its caller.
   */
  private handOver(record: VoiceTurnRecord, claim: VoiceTurnClaim): void {
    if (record.streamsSpeech && cutOffAt(claim) === null) {
      record.spoken.reached += 1;
    }
  }

  /**
   * Claims the conversation's pending teammate replies for this request. A request the session's
   * newer one overtook before its outcome left lost its caller, so it settles the replies it holds
   * first (within the note timeout): the ones this request reports heard to their end stay spoken,
   * and this request claims the rest. Across instances that turn is not seen here, and its replies
   * wait for it or for the claim's expiry.
   */
  private async claimOperatorReplies(claim: VoiceTurnClaim, record: VoiceTurnRecord, conversationId: string): Promise<ClaimedOperatorReply[]> {
    const overtaken = claim.overtook?.outcomeAt === null ? this.turnRecords.get(claim.overtook) : undefined;
    if (claim.overtook && overtaken?.operatorReplyClaims.holdsClaims) {
      const settled = overtaken.operatorReplyClaims.settle(operatorReplyPiecesHeard(overtaken, claim.overtook));
      await withinNoteTimeout(settled ?? Promise.resolve()).catch(() => undefined);
    }
    return record.operatorReplyClaims.claim(conversationId);
  }

  /** The teammate's claimed replies, spoken ahead of the turn's own answer, in the order they were written. */
  private *operatorReplySpeech(replies: readonly ClaimedOperatorReply[], record: VoiceTurnRecord, claim: VoiceTurnClaim): Generator<VoiceTurnEvent> {
    for (const piece of record.operatorReplyClaims.speech(replies)) {
      record.speechPieceCount += 1;
      this.handOver(record, claim);
      record.spoken.operatorReplies.push(piece.text);
      yield piece;
    }
  }

  /** The stored answer spoken again, sentence by sentence, with no chat turn behind it. */
  private async *replayEvents(
    input: VoiceTurnInput,
    exchange: ReplayableVoiceExchange,
    record: VoiceTurnRecord,
  ): AsyncGenerator<VoiceTurnEvent> {
    record.reply = exchange.reply;
    yield* lastSpeech(splitCompleteSentences(exchange.reply.text, { startsLine: true, final: true }), record);
    record.result = "replayed";
    recordVoiceTurnReplayed(this.dependencies.metrics);
    try {
      yield CONTINUE;
    } finally {
      // Written once the outcome has left, off the response's path: the turn neither waits for
      // the audit write nor depends on it to settle.
      this.noteReplayed(input, exchange);
    }
  }

  private noteReplayed(input: VoiceTurnInput, exchange: ReplayableVoiceExchange): void {
    const { notes } = this.dependencies;
    if (!notes) {
      return;
    }
    const note = {
      workspaceId: input.session.workspaceId,
      conversationId: exchange.conversationId,
      assistantMessageId: exchange.reply.messageId,
    };
    withinNoteTimeout(notes.replyReplayed(note)).catch((error: unknown) => this.warnNoteFailed(input, note.conversationId, error));
  }

  /**
   * Records, once, how much of the session's last stored reply the caller heard before speaking
   * over it. The note is written off the turn's path; the session counts it recorded only once the
   * write succeeds, so a failed one is written again on the next report.
   */
  private noteInterruptedReply(input: VoiceTurnInput, sessionKey: string, claim: VoiceTurnClaim): void {
    if (input.heardUntil === undefined) {
      return;
    }
    const overtaken = claim.overtook && !claim.overtook.settled ? this.turnRecords.get(claim.overtook) : undefined;
    if (overtaken && overtaken.spoken.reached > 0) {
      // The reply cut short is the one the turn this request overtook was saying, not the stored
      // exchange before it: that turn keeps the report for what it stores and settles. A turn
      // whose speech never reached the runtime left the runtime's history as it was.
      overtaken.reportedHeard ??= input.heardUntil;
      return;
    }
    this.reserveInterruptionNote(input, sessionKey, input.heardUntil);
  }

  private reserveInterruptionNote(input: VoiceTurnInput, sessionKey: string, heardUntil: string): void {
    const reservation = this.memory.reserveInterruption(sessionKey, heardUntil);
    if (!reservation) {
      return;
    }
    const { interruption } = reservation;
    const recorded = (): void => {
      reservation.recorded();
      this.reportInterruption(input, { ...interruption, partial: false });
    };
    const notes = this.dependencies.notes;
    if (!notes) {
      recorded();
      return;
    }
    withinNoteTimeout(notes.replyInterrupted({ workspaceId: input.session.workspaceId, ...interruption })).then(recorded, (error: unknown) => {
      reservation.failed();
      this.warnNoteFailed(input, interruption.conversationId, error);
    });
  }

  /** Counts and logs an interrupted reply once its record is durable. Ids and counts only. */
  private reportInterruption(
    input: VoiceTurnInput,
    interruption: { conversationId: string; assistantMessageId: string; heardCharacterCount: number; spokenCharacterCount: number; partial: boolean },
  ): void {
    recordVoiceReplyInterrupted(this.dependencies.metrics, interruption.partial);
    this.dependencies.logger.info({
      agentId: input.session.agentId,
      vendor: input.session.vendor,
      ...interruption,
    }, "Voice reply was interrupted");
  }

  private warnNoteFailed(input: VoiceTurnInput, conversationId: string, error: unknown): void {
    this.dependencies.logger.warn({
      agentId: input.session.agentId,
      vendor: input.session.vendor,
      conversationId,
      errorClass: errorClassOf(error),
    }, "Voice turn note could not be recorded");
  }

  /**
   * What the conversation keeps of the turn: its exchange once chat stored the user message
   * (with the answer when chat stored one), or undefined when it keeps nothing of it.
   */
  private exchangeOf(input: VoiceTurnInput, record: VoiceTurnRecord, claim: VoiceTurnClaim): VoiceExchange | undefined {
    const replaced = record.result === "superseded" && !record.chatReplied;
    if (!record.conversationId || replaced || (!record.chatPrepared && record.result !== "replayed")) {
      return undefined;
    }
    return {
      utterance: input.utterance,
      conversationId: record.conversationId,
      reply: record.reply,
      spoken: record.policy?.fallbackSpoken
        ? null
        : {
            ahead: [record.spoken.operatorReplies.join(""), record.spoken.bridge].filter((text): text is string => text !== null && hasSpokenWords(text)),
            reply: record.spoken.speech.join(""),
          },
      cutOffAt: cutOffAt(claim),
    };
  }

  private logTurn(input: VoiceTurnInput, record: VoiceTurnRecord, startedAt: number, finishedAt: number, failure: unknown): void {
    const { metrics, logger } = this.dependencies;
    const supersededAt = [...record.spoken.operatorReplies, ...record.spoken.speech].some((text) => text.length > 0) ? "after_speech" : "before_speech";
    if (record.result === "superseded") {
      recordVoiceTurnSuperseded(metrics, supersededAt);
    }
    if (record.outcome) {
      recordVoiceTurnOutcome(metrics, record.outcome.kind, record.handoffReason);
    }
    const fields = {
      agentId: input.session.agentId,
      vendor: input.session.vendor,
      transport: input.transport,
      conversationId: record.conversationId,
      result: record.result,
      ...(record.result === "superseded" ? { supersededAt } : {}),
      durationMs: finishedAt - startedAt,
      speechPieceCount: record.speechPieceCount,
      ...(record.operatorReplyClaims.spokenCount > 0 ? { spokenOperatorReplies: record.operatorReplyClaims.spokenCount } : {}),
      ...(record.outcome ? { outcome: record.outcome.kind } : {}),
      ...(record.handoffReason ? { handoffReason: record.handoffReason } : {}),
      ...(record.reply?.partial ? { storedPartialReply: true } : {}),
      ...record.policy,
    };
    if (record.result === "failed") {
      logger.warn({ ...fields, errorClass: errorClassOf(failure) }, "Voice turn failed");
    } else if (record.policy?.turnLimitReached) {
      // The caller heard the fallback line, or kept waiting when the agent has none for the locale.
      logger.warn(fields, "Voice turn reached the turn limit");
    } else {
      logger.info(fields, "Voice turn finished");
    }
  }

  /**
   * The chat turn's reply as voice events, re-cut into sentences, with the chat's status stages as
   * phase markers for the policy. Binds a new session as soon as chat names its conversation.
   */
  private async *replyEvents(
    input: VoiceTurnInput,
    sessionClaim: SessionClaim,
    record: VoiceTurnRecord,
    signal: AbortSignal,
    sessionKey: string,
  ): AsyncGenerator<VoiceReplyEvent> {
    const speech = createSentenceCutter();
    this.memory.chatTurnStarted(sessionKey, this.now());
    try {
      for await (const event of this.dependencies.chat.streamTurn({
        workspaceId: input.session.workspaceId,
        agentId: input.session.agentId,
        ...(sessionClaim.conversationId ? { conversationId: sessionClaim.conversationId } : {}),
        ...(sessionClaim.conversationId === null && sessionClaim.visitorKey ? { visitorKey: sessionClaim.visitorKey } : {}),
        message: input.utterance,
        sourceChannel: VOICE_SOURCE_CHANNEL,
        channelContext: channelContextFor(input),
        supersession: "latest_input_wins",
        deliveredReply: () => {
          record.deliveredPart = this.deliveredReplyPart(input, record);
          return record.deliveredPart;
        },
        signal,
      })) {
        record.chatPrepared = true;
        // A human-owned turn answers with `done` alone, so either event can name the conversation.
        if (!record.conversationId && (event.type === "conversation" || event.type === "done")) {
          record.conversationId = event.conversationId;
          await this.bindNewSession(input.session, record.conversationId);
          this.releaseFirstTurn(input.session, sessionClaim.conversationId === null ? sessionClaim.firstTurn : undefined);
          yield { type: "conversation", conversationId: record.conversationId };
        }

        if (event.type === "status") {
          yield { type: "phase", phase: PHASE_OF_STAGE[event.stage] };
        } else if (event.type === "chunk") {
          record.chatReplied = true;
          record.written += event.text;
          for (const text of speech.push(event.text)) {
            record.speechPieceCount += 1;
            yield { type: "speech", text, last: false };
          }
        } else if (event.type === "done") {
          record.reply = event.assistantMessageId ? { messageId: event.assistantMessageId, text: event.answer } : null;
          const { outcome, handoffReason } = deriveVoiceTurnOutcome(event);
          record.handoffReason = handoffReason;
          yield* lastSpeech(speech.finish(), record);
          yield { type: "outcome", outcome };
          record.result = "completed";
          // What follows `done` is suggestion enrichment, which nobody hears.
          return;
        } else if (event.type === "cancelled") {
          // A newer turn on the conversation superseded this one and owns the reply now. Chat kept
          // the part the caller heard, when some did, as this turn's reply, marked cut short.
          if (event.assistantMessageId && record.deliveredPart && record.conversationId) {
            // Stored with its audit event in one transaction, so it is counted as it commits.
            record.reply = { messageId: event.assistantMessageId, text: record.deliveredPart.text.trimEnd(), partial: true };
            this.reportInterruption(input, {
              conversationId: record.conversationId,
              assistantMessageId: event.assistantMessageId,
              heardCharacterCount: record.deliveredPart.heardCharacterCount,
              spokenCharacterCount: record.deliveredPart.spokenCharacterCount,
              partial: true,
            });
          }
          yield CONTINUE;
          record.result = "superseded";
          return;
        }
      }
      // Chat ends every turn with `done` or `cancelled`; a stream that simply stops has no outcome to give.
      throw new VoiceTurnIncompleteError();
    } finally {
      this.memory.chatTurnEnded(sessionKey, this.now());
    }
  }

  /**
   * What chat keeps of the turn's answer when a newer utterance cuts it off mid-stream: its whole
   * sentences the caller heard, as the answer streamed them, by the runtime's own record of what it
   * played (reported by the request that cut in), with the characters heard and those that reached
   * the runtime. Without a report, or with one that does not match what reached the runtime (which
   * warns, with counts only), every sentence that reached it counts as heard. Null when no sentence
   * with words was heard, or the caller heard the fallback line in the answer's place.
   */
  private deliveredReplyPart(input: VoiceTurnInput, record: VoiceTurnRecord): DeliveredReplyPart | null {
    const reached = reachedSpeechOf(record);
    const reported = record.reportedHeard === undefined ? null : heardSpeechOf(reached, record.reportedHeard);
    if (record.reportedHeard !== undefined && reported === null) {
      this.dependencies.logger.warn({
        agentId: input.session.agentId,
        vendor: input.session.vendor,
        conversationId: record.conversationId,
        reachedCharacterCount: spokenLength(reached.answer.join("")),
        reportedCharacterCount: spokenLength(record.reportedHeard),
      }, "Voice reply reported heard does not match what reached the runtime; the stored part follows what reached it");
    }
    const heard: HeardSpeech | null = reported ?? heardSpeechOf(reached);
    const pieces = reached.answer.slice(0, heard?.answerPieces ?? 0);
    const spoken = pieces.join("");
    if (!heard || !hasSpokenWords(spoken)) {
      return null;
    }
    const writtenLength = writtenLengthSpokenAs(record.written, spoken);
    const counts = { heardCharacterCount: heard.answerHeardCharacterCount, spokenCharacterCount: heard.answerSpokenCharacterCount };
    return {
      text: writtenLength === null ? spoken : record.written.slice(0, writtenLength),
      ...counts,
      auditEvent: { eventType: VOICE_REPLY_INTERRUPTED_EVENT, metadata: { ...counts, partial: true } },
    };
  }

  /**
   * The bridge and the turn limit, when the agent has voice on. Three primary-key reads: the agent's
   * settings, and the conversation's routine state and owner (a session's first turn has neither).
   */
  private async policyFor(
    input: VoiceTurnInput,
    conversationId: string | null,
    startedAt: number,
    record: VoiceTurnRecord,
    mayBridge: () => boolean,
  ): Promise<VoiceTurnPolicy | null> {
    const [profile, routineActive, humanOwned] = await Promise.all([
      this.dependencies.agents.findVoiceProfile(input.session),
      conversationId ? this.dependencies.routines.isRoutineActive(conversationId) : Promise.resolve(false),
      conversationId ? this.dependencies.ownership.isHumanOwned(conversationId) : Promise.resolve(false),
    ]);
    if (!profile?.voice.enabled) {
      return null;
    }
    const { shortBridge, ...lines } = chooseVoiceTurnLines(profile.voice, {
      locale: resolveVoiceTurnLocale({ requested: input.locale, agentDefault: profile.defaultLocale }),
      routineActive,
      rotation: this.policyTurns++,
      ...(input.minReleasableSentenceChars === undefined ? {} : { minReleasableChars: input.minReleasableSentenceChars }),
    });
    if (shortBridge && !humanOwned) {
      this.warnShortBridgeOnce(input, shortBridge);
    }
    const outcome = { bridged: false, turnLimitReached: false, fallbackSpoken: false };
    record.policy = outcome;
    const { metrics } = this.dependencies;
    return {
      ...lines,
      // The bridge and the limit cover the agent's own answers. When a person owns the
      // conversation, chat answers with its short waiting message, and neither a bridge line
      // before it nor a fallback line over it belongs on the call.
      bridge: humanOwned ? null : lines.bridge,
      bridgeAfterMs: this.timing.bridgeAfterMs,
      bridgeAfterComposingIdleMs: this.timing.bridgeAfterComposingIdleMs,
      turnLimitMs: humanOwned ? null : this.timing.turnLimitMs,
      startedAt,
      now: this.now,
      mayBridge,
      observer: {
        bridgeDue: (style, spoken) => {
          outcome.bridged = spoken;
          recordVoiceBridgeDue(metrics, style, spoken);
        },
        turnLimitReached: (spoken) => {
          outcome.turnLimitReached = true;
          outcome.fallbackSpoken = spoken;
          recordVoiceTurnLimit(metrics, spoken);
        },
        drainingAfterLimit: (drained) => {
          record.drain = drained;
        },
        firstSpeech: (elapsedMs, bridged) => recordVoiceFirstSpeech(metrics, elapsedMs, bridged),
      },
    };
  }

  /**
   * The line is still spoken; the runtime holds it until the answer's text arrives, so the bridge
   * covers less of the wait. Once per agent per process, with lengths only.
   */
  private warnShortBridgeOnce(
    input: VoiceTurnInput,
    shortBridge: { characterCount: number; minimumCharacterCount: number },
  ): void {
    const agentKey = JSON.stringify([input.session.workspaceId, input.session.agentId]);
    if (this.shortBridgeWarned.has(agentKey)) {
      return;
    }
    this.shortBridgeWarned.add(agentKey);
    this.dependencies.logger.warn({
      event: "voice.bridge_line_below_vendor_minimum",
      agentId: input.session.agentId,
      vendor: input.session.vendor,
      lineCharacterCount: shortBridge.characterCount,
      minimumCharacterCount: shortBridge.minimumCharacterCount,
    }, "Voice bridge line is shorter than the runtime speaks on its own");
  }

  private async claimSession(session: VoiceSessionRef): Promise<SessionClaim> {
    const key = sessionKeyOf(session);
    for (;;) {
      await this.firstTurns.get(key)?.settled;
      const conversationId = await this.dependencies.sessions.findConversationId(session);
      if (conversationId) {
        return { conversationId };
      }
      // Re-checked after the lookup: another turn may have claimed the session meanwhile.
      if (!this.firstTurns.has(key)) {
        const firstTurn = createFirstTurn();
        this.firstTurns.set(key, firstTurn);
        return { conversationId: null, firstTurn, visitorKey: await this.startedVisitorKey(session) };
      }
    }
  }

  /**
   * The grouping key of the visitor a Radioso-started session was started for: the embed's visitor
   * key, else its public session, which is what the embed's own chat groups by. Correlation only, so
   * a start that cannot be read leaves the turn without a visitor rather than failing it.
   */
  private async startedVisitorKey(session: VoiceSessionRef): Promise<string | null> {
    if (!this.dependencies.starts) return null;
    try {
      const visitor = await this.dependencies.starts.findStartedVisitor(session);
      return visitor ? visitor.visitorKey ?? visitor.publicSessionId : null;
    } catch (error) {
      this.dependencies.logger.warn(
        { agentId: session.agentId, vendor: session.vendor, errorClass: errorClassOf(error) },
        "Voice session start could not be read; the turn runs without its visitor",
      );
      return null;
    }
  }

  private releaseFirstTurn(session: VoiceSessionRef, firstTurn: FirstTurn | undefined): void {
    if (!firstTurn) {
      return;
    }
    const key = sessionKeyOf(session);
    if (this.firstTurns.get(key) === firstTurn) {
      this.firstTurns.delete(key);
    }
    firstTurn.settle();
  }

  private async bindNewSession(session: VoiceSessionRef, conversationId: string): Promise<void> {
    const boundConversationId = await this.dependencies.sessions.bind(session, conversationId);
    if (boundConversationId !== conversationId) {
      // Two first turns raced; the session follows the first binding, this turn's reply stays in its own.
      this.dependencies.logger.warn({
        agentId: session.agentId,
        vendor: session.vendor,
        conversationId,
        boundConversationId,
      }, "Voice session was bound to another conversation by a concurrent first turn");
    }
  }
}
