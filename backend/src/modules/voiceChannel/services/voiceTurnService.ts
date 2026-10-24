import { randomUUID } from "node:crypto";

import type {
  ChatStreamEvent,
  ConversationTurnSupersession,
  DeliveredReplyPart,
  DeliveredReplyReader,
  OperatorReplySpeechClaims,
  VoiceTurnFacts,
} from "../../chat/contracts/index.js";
import { errorClassOf } from "../../../shared/observability/errorClass.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import { VOICE_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import { VOICE_SOURCE_CHANNEL } from "../../../shared/domain/conversationSource.js";
import {
  VOICE_REPLY_INTERRUPTED_EVENT,
  VOICE_TURN_LOG_EVENT,
  VoiceTurnIncompleteError,
  type VoiceChannelContext,
  type VoiceSessionRef,
  type VoiceSessionStartLookup,
  type VoiceTurnEvent,
  type VoiceTurnInput,
  type VoiceTurnPort,
} from "../domain.js";
import { chooseVoiceTurnLines } from "./voiceLines.js";
import {
  recordVoiceBridgeDue,
  recordVoiceFirstSpeech,
  recordVoiceReplyInterrupted,
  recordVoiceTurnAbandoned,
  recordVoiceTurnLanguage,
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
  type VoiceTurnPhase,
  type VoiceTurnPolicy,
} from "./voiceTurnPolicy.js";
import { LanguageSwitchFollowUps, type VoiceStoredReplyReader } from "./languageSwitchFollowUp.js";
import {
  chatTurnOf,
  CONTINUE,
  emptyRecord,
  endWithoutSpeech,
  isAnswerSpeech,
  languageFields,
  lastSpeech,
  answerSpeech,
  speakerOf,
  storedSpeech,
  type PreparedVoicePolicy,
  type VoiceAgentProfile,
  type VoiceTurnRecord,
  type VoiceTurnSetting,
} from "./voiceTurnRecord.js";
import { OperatorReplySpeaker, type ClaimedOperatorReply, type OperatorReplySpeakerDependencies } from "./operatorReplySpeaker.js";
import { createSentenceCutter } from "./speechSegmenter.js";
import { hasSpokenWords, spokenLength } from "./speechText.js";
import { heardSpeechOf, type HeardSpeech, type ReachedSpeech } from "./heardSpeech.js";
import {
  cutOffAt,
  VoiceSessionMemory,
  type ReplayableVoiceExchange,
  type VoiceExchange,
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
  /**
   * On a session's first turn: the privacy notice version the page showed, which chat records on the
   * conversation the turn starts when the agent's notices carry it.
   */
  privacyNoticeVersion?: string;
  /**
   * The language the request reports as news on this turn (`VoiceTurnInput.turnLanguage` with
   * `isNew`), as chat's locale hint. Absent otherwise: chat then reads the caller's
   * language from what they said, so neither the session's locale nor a switch an earlier turn made
   * holds a caller who moved on to it.
   */
  userExpectedLocale?: string;
  /** On a turn that may switch the call's language: the stream reports the language the turn answers in before the answer. */
  reportResponseLanguage?: true;
  signal: AbortSignal;
}

/** The streaming chat turn every other channel runs. */
interface VoiceChatPort {
  streamTurn(request: VoiceChatTurnRequest): AsyncIterable<ChatStreamEvent>;
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
  switchFollowUpPollMs: number;
  languageSwitchDecisionMs: number;
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
  /** How the turn went for its caller, kept on the reply it stored and spoke: timings and closed values only. */
  turnFacts(note: { workspaceId: string; conversationId: string; assistantMessageId: string; facts: VoiceTurnFacts }): Promise<void>;
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
  /** Mints the id of each switch of the call's language a turn asks the runtime for. */
  newLanguageSwitchId?: () => string;
  /** Read by a switch's follow-up that finds no switched turn here; without it, that follow-up waits for the turn limit. */
  storedReplies?: VoiceStoredReplyReader;
  /** Overrides `VOICE_BEHAVIOR`; tests only. */
  timing?: Partial<VoiceTurnTiming>;
  now?: () => number;
}

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

/** The speech that reached the runtime before the turn lost its caller, in order. */
const reachedSpeechOf = (record: VoiceTurnRecord): ReachedSpeech => ({
  operatorReplies: record.spoken.operatorReplies.filter((piece) => piece.reached).map((piece) => piece.text),
  bridge: record.spoken.bridge,
  answer: record.spoken.answer.filter((piece) => piece.reached).map((piece) => piece.text),
});

/**
 * When the caller first heard the turn, from its start: the policy's first speech, timed from the
 * switched turn's start on a follow-up that speaks a switched turn's answer. Unknown (null) on a
 * follow-up that holds no switched turn here, which can time only its own request, and on a
 * response that is not streamed, whose speech reaches the runtime only with the outcome.
 */
const firstSpeechMsOf = (record: VoiceTurnRecord): number | null =>
  record.languageSwitch === "unheld" || !record.streamsSpeech ? null : record.policy?.firstSpeechMs ?? null;

/**
 * The facts the turn keeps on the reply it spoke of its own, with that reply's id; null when it
 * stored none. A replay speaks an earlier turn's reply, which keeps that turn's facts, and a turn
 * that switched the call's language speaks nothing: its follow-up keeps the facts of its answer.
 */
const turnFactsOf = (record: VoiceTurnRecord): { assistantMessageId: string; facts: VoiceTurnFacts } | null => {
  const assistantMessageId = chatTurnOf(record).reply?.messageId;
  if (!assistantMessageId || record.result === "replayed" || record.languageSwitch === "emitted") {
    return null;
  }
  const outcome = record.switched?.reply.outcome() ?? record.outcome;
  return {
    assistantMessageId,
    facts: {
      firstSpeechMs: firstSpeechMsOf(record),
      bridged: record.policy?.bridged ?? false,
      turnLimitReached: record.policy?.turnLimitReached ?? false,
      outcome: outcome?.kind ?? null,
    },
  };
};

/** Whether any of the turn's speech reached the runtime before the turn lost its caller. */
const anyReached = (record: VoiceTurnRecord): boolean =>
  [...record.spoken.operatorReplies, ...record.spoken.answer].some((piece) => piece.reached);

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
  return record.reported?.heard?.operatorReplyPieces ?? 0;
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
  /** A turn's switch of the call's language and the runtime's follow-up after it. */
  private readonly switching: LanguageSwitchFollowUps;

  constructor(private readonly dependencies: VoiceTurnServiceDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.timing = { ...VOICE_BEHAVIOR, ...dependencies.timing };
    this.memory = new VoiceSessionMemory(this.timing);
    this.switching = new LanguageSwitchFollowUps({
      steps: {
        policyFor: (...step) => this.policyFor(...step),
        policyWith: (...step) => this.policyWith(...step),
        claimOperatorReplies: (...step) => this.claimOperatorReplies(...step),
        operatorReplySpeech: (...step) => this.operatorReplySpeech(...step),
        delivered: (...step) => this.delivered(...step),
        mayBridgeFor: (...step) => this.mayBridgeFor(...step),
      },
      memory: this.memory,
      sessions: dependencies.sessions,
      ownership: dependencies.ownership,
      ...(dependencies.storedReplies ? { storedReplies: dependencies.storedReplies } : {}),
      timing: this.timing,
      newLanguageSwitchId: dependencies.newLanguageSwitchId ?? randomUUID,
      now: this.now,
      logger: dependencies.logger,
      metrics: dependencies.metrics,
    });
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
      claim.lost.abort();
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
      if (input.languageSwitchResult) {
        yield* this.switching.followUp(input, input.languageSwitchResult, claim, record, sessionKey, startedAt);
        return;
      }
      // The caller said something new: a switched turn still waiting for its follow-up gets none.
      this.switching.drop(sessionKey);
      this.noteInterruptedReply(input, sessionKey, claim);
      const replay = this.memory.replayFor(sessionKey, input.utterance, startedAt);
      if (replay) {
        // The teammate's replies the caller has not heard come before the answer heard again.
        record.conversationId = replay.conversationId;
        const replies = await this.claimOperatorReplies(claim, record, replay.conversationId);
        if (claim.supersededAt !== null) {
          // Overtaken while claiming: the newer request owns the session, and the claim goes back.
          yield* endWithoutSpeech(record, "superseded");
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
      const mayBridge = this.mayBridgeFor(record, sessionKey, claim);
      const [prepared, replies] = claim.supersededAt === null
        ? await Promise.all([
            this.policyFor(input, sessionClaim.conversationId, startedAt, record, mayBridge, { sessionKey, claim }),
            sessionClaim.conversationId ? this.claimOperatorReplies(claim, record, sessionClaim.conversationId) : [],
          ])
        : [null, []];
      if (claim.supersededAt !== null) {
        // A newer request of the session arrived while this one was setting up; it owns the turn,
        // and the replies this one claimed go back to pending as it settles.
        yield* endWithoutSpeech(record, "superseded");
        return;
      }
      if (sessionClaim.conversationId) {
        yield { type: "conversation", conversationId: sessionClaim.conversationId };
        yield* this.operatorReplySpeech(replies, record, claim);
      }
      if (prepared?.linesLanguage) {
        // The turn runs with its lines from here on, so their language is the turn's to report.
        record.language = prepared.linesLanguage;
      }
      // Only a turn that may switch the call's language asks chat for its language.
      const reply = this.replyEvents(input, sessionClaim, record, signal, sessionKey, prepared?.policy.languageSwitch !== undefined);
      yield* this.delivered(prepared ? applyVoiceTurnPolicy(reply, prepared.policy) : withoutPhaseMarkers(reply), record, claim, sessionKey);
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
        if (record.reported && exchange?.reply && !exchange.reply.partial) {
          // A newer request reported this turn's whole reply cut short before the turn settled; it
          // is measured against this turn's exchange, whichever turn of the session settled last.
          this.writeInterruptionNote(input, this.memory.reserveInterruptionOf(exchange, record.reported.text));
        }
        // The log names how many replies were recorded spoken, so it waits for the settling writes;
        // its duration is the turn's own. The facts are the same record's, written beside it.
        const report = (): void => {
          this.logTurn(input, record, startedAt, finishedAt, failure);
          this.noteTurnFacts(input, record);
        };
        if (repliesSettled) {
          void repliesSettled.then(report);
        } else {
          report();
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

  /**
   * Whether the request may speak its bridge line now: no line follows a teammate's reply (the
   * caller has just heard someone speak), and the session memory's rule holds.
   */
  private mayBridgeFor(record: VoiceTurnRecord, sessionKey: string, claim: VoiceTurnClaim): () => boolean {
    return () => record.spoken.operatorReplies.length === 0 && this.memory.mayBridge(sessionKey, claim, this.now());
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
      } else if (isAnswerSpeech(event)) {
        record.speechPieceCount += 1;
        record.spoken.answer.push({ text: event.text, writtenEnd: event.writtenEnd, reached: this.reaches(record, claim) });
        // Where the piece ends in the written answer is the turn's own bookkeeping, not the port's.
        yield { type: "speech", text: event.text, last: event.last };
        continue;
      } else if (event.type === "speech") {
        // The only other speech is the policy's fallback line, spoken in the answer's place.
        record.spoken.fallback = event.text;
      } else if (event.type === "outcome") {
        claim.outcomeAt ??= this.now();
        record.outcome = event.outcome;
      }
      yield event;
    }
  }

  /** Whether the speech piece leaving now reaches the runtime: the response streams it and the turn still has its caller. */
  private reaches(record: VoiceTurnRecord, claim: VoiceTurnClaim): boolean {
    return record.streamsSpeech && cutOffAt(claim) === null;
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
      record.spoken.operatorReplies.push({ text: piece.text, reached: this.reaches(record, claim) });
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
    yield* storedSpeech(exchange.reply.text);
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
    withinNoteTimeout(notes.replyReplayed(note)).catch((error: unknown) => this.warnNoteFailed(input, "reply_replayed", note.conversationId, error));
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
    if (overtaken && anyReached(overtaken)) {
      // The reply cut short is the one the turn this request overtook was saying, not the stored
      // exchange before it: that turn keeps the report for what it stores and settles. A turn
      // whose speech never reached the runtime left the runtime's history as it was. Its speech
      // stopped reaching the runtime when this request arrived, so the measure is final.
      if (!overtaken.reported) {
        overtaken.reported = { text: input.heardUntil, heard: this.measureReported(input, overtaken, input.heardUntil) };
      }
      return;
    }
    this.writeInterruptionNote(input, this.memory.reserveInterruption(sessionKey, input.heardUntil));
  }

  /**
   * How much of what reached the runtime for `record` its caller heard, by `report`. A report that
   * does not match it warns once, with counts only: the stored part then follows what reached the
   * runtime, and the teammate's replies go back to pending.
   */
  private measureReported(input: VoiceTurnInput, record: VoiceTurnRecord, report: string): HeardSpeech | null {
    const reached = reachedSpeechOf(record);
    const heard = heardSpeechOf(reached, report);
    if (!heard) {
      this.dependencies.logger.warn({
        agentId: input.session.agentId,
        vendor: input.session.vendor,
        conversationId: record.conversationId,
        reachedCharacterCount: spokenLength([...reached.operatorReplies, reached.bridge ?? "", ...reached.answer].join(" ")),
        reportedCharacterCount: spokenLength(report),
      }, "Voice reply reported heard does not match what reached the runtime; the stored part follows what reached it");
    }
    return heard;
  }

  /** Writes a finished reply's interruption note off the turn's path, once the session reserved it. */
  private writeInterruptionNote(input: VoiceTurnInput, reservation: ReturnType<VoiceSessionMemory["reserveInterruption"]>): void {
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
      this.warnNoteFailed(input, "reply_interrupted", interruption.conversationId, error);
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

  /**
   * Keeps the finished turn's facts on the reply it stored, off the turn's path: the turn neither
   * waits for the write nor fails with it.
   */
  private noteTurnFacts(input: VoiceTurnInput, record: VoiceTurnRecord): void {
    const { notes } = this.dependencies;
    const { conversationId } = record;
    const kept = turnFactsOf(record);
    if (!notes || !conversationId || !kept) {
      return;
    }
    withinNoteTimeout(notes.turnFacts({ workspaceId: input.session.workspaceId, conversationId, ...kept }))
      .catch((error: unknown) => this.warnNoteFailed(input, "turn_facts", conversationId, error));
  }

  /** Names the note that failed (the teammate replies' audit warns the same way from the speaker). */
  private warnNoteFailed(input: VoiceTurnInput, note: "reply_interrupted" | "reply_replayed" | "turn_facts", conversationId: string, error: unknown): void {
    this.dependencies.logger.warn({
      agentId: input.session.agentId,
      vendor: input.session.vendor,
      conversationId,
      errorClass: errorClassOf(error),
      note,
    }, "Voice turn note could not be recorded");
  }

  /**
   * What the conversation keeps of the turn: its exchange once chat stored the user message
   * (with the answer when chat stored one), or undefined when it keeps nothing of it.
   */
  private exchangeOf(input: VoiceTurnInput, record: VoiceTurnRecord, claim: VoiceTurnClaim): VoiceExchange | undefined {
    // A switch's follow-up speaks the answer the switched turn's chat turn wrote and stored, or
    // one it read from the conversation.
    const chatTurn = chatTurnOf(record);
    const replaced = chatTurn.result === "superseded" && !chatTurn.chatReplied;
    const kept = chatTurn.chatPrepared || record.result === "replayed" || record.spokeStoredReply === true;
    if (!record.conversationId || replaced || !kept) {
      return undefined;
    }
    return {
      utterance: input.utterance,
      conversationId: record.conversationId,
      reply: chatTurn.reply,
      spoken: record.spoken.fallback !== null
        ? null
        : {
            operatorReplies: record.spoken.operatorReplies.map((piece) => piece.text),
            bridge: record.spoken.bridge,
            answer: record.spoken.answer.map((piece) => piece.text),
          },
      cutOffAt: cutOffAt(claim) ?? (record.switched?.switching === record ? record.switched.unheardAt : null),
    };
  }

  private logTurn(input: VoiceTurnInput, record: VoiceTurnRecord, startedAt: number, finishedAt: number, failure: unknown): void {
    const { metrics, logger } = this.dependencies;
    const spokenTexts = [...record.spoken.operatorReplies, ...record.spoken.answer].map((piece) => piece.text).concat(record.spoken.fallback ?? []);
    const supersededAt = spokenTexts.some((text) => text.length > 0) ? "after_speech" : "before_speech";
    if (record.result === "superseded") {
      recordVoiceTurnSuperseded(metrics, supersededAt);
    } else if (record.result === "abandoned") {
      recordVoiceTurnAbandoned(metrics);
    }
    // A turn that switched the call's language counts neither its outcome nor its lines' language
    // here: the follow-up that speaks its answer counts the lines' language, and the switched
    // reply's outcome is counted once as it ends. A follow-up that found no switched turn counts
    // no outcome either.
    const handoffReason = chatTurnOf(record).handoffReason;
    // A turn that switched delivered only the switch, and its follow-up maybe a part of the answer;
    // the switched reply's own outcome is the turn's, counted once by `countSwitchedOutcome`.
    const outcome = record.switched?.reply.outcome() ?? record.outcome;
    if (outcome && record.languageSwitch === undefined) {
      recordVoiceTurnOutcome(metrics, outcome.kind, handoffReason);
    }
    if (record.language && record.languageSwitch !== "emitted") {
      recordVoiceTurnLanguage(metrics, record.language.source);
    }
    // A failure of the switched turn's reply is that turn's to report, once.
    const failedWithSwitchedTurn = record.result === "failed" && record.switched?.speaker === record && record.switched.reply.failedWith(failure);
    // One line per turn, named by one event whichever message it carries: the alert counts it by
    // this event and the line's fields.
    const fields = {
      event: VOICE_TURN_LOG_EVENT,
      agentId: input.session.agentId,
      vendor: input.session.vendor,
      transport: input.transport,
      conversationId: record.conversationId,
      result: record.result,
      ...(record.result === "superseded" ? { supersededAt } : {}),
      durationMs: finishedAt - startedAt,
      speechPieceCount: record.speechPieceCount,
      ...(record.operatorReplyClaims.spokenCount > 0 ? { spokenOperatorReplies: record.operatorReplyClaims.spokenCount } : {}),
      ...(outcome ? { outcome: outcome.kind } : {}),
      ...(handoffReason ? { handoffReason } : {}),
      ...(chatTurnOf(record).reply?.partial ? { storedPartialReply: true } : {}),
      ...record.policy,
      ...languageFields(record.language, input),
      ...(record.languageSwitch ? { languageSwitch: record.languageSwitch } : {}),
    };
    if (failedWithSwitchedTurn) {
      logger.info(fields, "Voice language switch follow-up ended with its switched turn's failure");
    } else if (record.result === "failed") {
      logger.warn({ ...fields, errorClass: errorClassOf(failure) }, "Voice turn failed");
    } else if (record.result === "abandoned") {
      // The runtime gave up on the request before the turn reached its outcome, whatever else the
      // turn reached: the caller heard no end to it.
      logger.warn(fields, "Voice turn abandoned before it finished");
    } else if (record.languageSwitch === "unheld") {
      // The expected path when the switched turn runs on another instance: the caller heard its
      // stored answer whole, or the fallback line.
      logger.info(fields, "Voice language switch follow-up found no switched turn here");
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
    reportsLanguage: boolean,
  ): AsyncGenerator<VoiceReplyEvent> {
    const speech = createSentenceCutter();
    this.memory.chatTurnStarted(sessionKey, this.now());
    try {
      for await (const event of this.dependencies.chat.streamTurn({
        workspaceId: input.session.workspaceId,
        agentId: input.session.agentId,
        ...(sessionClaim.conversationId ? { conversationId: sessionClaim.conversationId } : {}),
        ...(sessionClaim.conversationId === null && sessionClaim.visitorKey ? { visitorKey: sessionClaim.visitorKey } : {}),
        ...(sessionClaim.conversationId === null && input.privacyNoticeVersion ? { privacyNoticeVersion: input.privacyNoticeVersion } : {}),
        message: input.utterance,
        ...(input.turnLanguage?.isNew ? { userExpectedLocale: input.turnLanguage.tag } : {}),
        sourceChannel: VOICE_SOURCE_CHANNEL,
        channelContext: channelContextFor(input),
        supersession: "latest_input_wins",
        ...(reportsLanguage ? { reportResponseLanguage: true as const } : {}),
        deliveredReply: () => {
          // A switched turn's answer reaches its caller through the runtime's follow-up request.
          record.deliveredPart = this.deliveredReplyPart(input, speakerOf(record), record.written);
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
        } else if (event.type === "language") {
          yield event.tag ? { type: "language", tag: event.tag } : { type: "language" };
        } else if (event.type === "chunk") {
          record.chatReplied = true;
          record.written += event.text;
          for (const piece of speech.push(event.text)) {
            yield answerSpeech(piece, false);
          }
        } else if (event.type === "done") {
          record.reply = event.assistantMessageId ? { messageId: event.assistantMessageId, text: event.answer } : null;
          const { outcome, handoffReason } = deriveVoiceTurnOutcome(event);
          record.handoffReason = handoffReason;
          yield* lastSpeech(speech.finish());
          yield { type: "outcome", outcome };
          record.result = "completed";
          // What follows `done` is suggestion enrichment, which nobody hears.
          return;
        } else if (event.type === "cancelled") {
          // A newer turn on the conversation superseded this one and owns the reply now. Chat kept
          // the part the caller heard, when some did, as this turn's reply, marked cut short.
          const stored = event.storedReply;
          if (stored?.partial && record.deliveredPart && record.conversationId) {
            // Stored with its audit event in one transaction, so it is counted as it commits.
            record.reply = { messageId: stored.assistantMessageId, text: record.deliveredPart.text.trimEnd(), partial: true };
            this.reportInterruption(input, {
              conversationId: record.conversationId,
              assistantMessageId: stored.assistantMessageId,
              heardCharacterCount: record.deliveredPart.heardCharacterCount,
              spokenCharacterCount: record.deliveredPart.spokenCharacterCount,
              partial: true,
            });
          } else if (stored && !stored.partial) {
            // Chat had stored the whole reply before the cut: it is the turn's reply, as it streamed.
            record.reply = { messageId: stored.assistantMessageId, text: record.written };
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
   * sentences the caller heard, as the answer streamed them (up to where the last of them ends in
   * the written text, as the sentence cutter reports it), by the runtime's own record of what it
   * played (reported by the request that cut in), with the characters heard and those that reached
   * the runtime. Without a report, or with one that does not match what reached the runtime (which
   * warns, with counts only), every sentence that reached it counts as heard. Null when no sentence
   * with words was heard, or the caller heard the fallback line in the answer's place.
   */
  private deliveredReplyPart(input: VoiceTurnInput, record: VoiceTurnRecord, written: string): DeliveredReplyPart | null {
    const heard: HeardSpeech | null = record.reported?.heard ?? heardSpeechOf(reachedSpeechOf(record));
    const pieces = record.spoken.answer.filter((piece) => piece.reached).slice(0, heard?.answerPieces ?? 0);
    const lastHeard = pieces.at(-1);
    if (!heard || !lastHeard || !hasSpokenWords(pieces.map((piece) => piece.text).join(""))) {
      return null;
    }
    if (lastHeard.writtenEnd === null) {
      // The sentence cutter could not place the last heard sentence in the written answer, so no
      // stored part could be trusted to hold what was said.
      this.dependencies.logger.warn({
        agentId: input.session.agentId,
        vendor: input.session.vendor,
        conversationId: record.conversationId,
        heardPieceCount: pieces.length,
        writtenCharacterCount: written.length,
      }, "Voice reply's heard sentences could not be placed in its written text; no part of it is stored");
      return null;
    }
    const counts = { heardCharacterCount: heard.answerHeardCharacterCount, spokenCharacterCount: heard.answerSpokenCharacterCount };
    return {
      text: written.slice(0, lastHeard.writtenEnd),
      ...counts,
      auditEvent: { eventType: VOICE_REPLY_INTERRUPTED_EVENT, metadata: { ...counts, partial: true } },
    };
  }

  /**
   * The bridge and the turn limit, when the agent has voice on, with the language the lines were
   * picked in (null on a turn a person owns, which speaks neither line). Three primary-key reads:
   * the agent's settings, and the conversation's routine state and owner (a session's first turn
   * has neither).
   */
  private async policyFor(
    input: VoiceTurnInput,
    conversationId: string | null,
    startedAt: number,
    record: VoiceTurnRecord,
    mayBridge: () => boolean,
    /** The request's place in its session, when the turn may switch the call's language; null when it may not ask. */
    switching: { sessionKey: string; claim: VoiceTurnClaim } | null,
  ): Promise<PreparedVoicePolicy | null> {
    const [profile, routineActive, humanOwned] = await Promise.all([
      this.dependencies.agents.findVoiceProfile(input.session),
      conversationId ? this.dependencies.routines.isRoutineActive(conversationId) : Promise.resolve(false),
      conversationId ? this.dependencies.ownership.isHumanOwned(conversationId) : Promise.resolve(false),
    ]);
    return this.policyWith(input, { profile, routineActive, humanOwned }, startedAt, record, mayBridge, switching);
  }

  /** The policy over what the turn read (`policyFor`), or what the turn it follows up read. */
  private policyWith(
    input: VoiceTurnInput,
    setting: VoiceTurnSetting,
    startedAt: number,
    record: VoiceTurnRecord,
    mayBridge: () => boolean,
    switching: { sessionKey: string; claim: VoiceTurnClaim } | null,
  ): PreparedVoicePolicy | null {
    const { profile, routineActive, humanOwned } = setting;
    if (!profile?.voice.enabled) {
      return null;
    }
    const { shortBridge, language, ...lines } = chooseVoiceTurnLines(profile.voice, {
      languages: { turn: input.turnLanguage, session: input.locale, agentDefault: profile.defaultLocale },
      routineActive,
      rotation: this.policyTurns++,
      ...(input.minReleasableSentenceChars === undefined ? {} : { minReleasableChars: input.minReleasableSentenceChars }),
    });
    if (shortBridge && !humanOwned) {
      this.warnShortBridgeOnce(input, shortBridge);
    }
    const outcome: NonNullable<VoiceTurnRecord["policy"]> = { bridged: false, turnLimitReached: false, fallbackSpoken: false };
    record.policy = outcome;
    const { metrics } = this.dependencies;
    // Only the agent's own answers switch: a person who owns the conversation answers in theirs.
    const languageSwitch = switching !== null && input.languageSwitchOffer && profile.voice.languageSwitching === true && !humanOwned
      ? this.switching.offerFor(input, { profile, routineActive }, record, { ...switching, startedAt })
      : undefined;
    const policy: VoiceTurnPolicy = {
      ...(languageSwitch ? { languageSwitch } : {}),
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
        firstSpeech: (elapsedMs, bridged) => {
          outcome.firstSpeechMs ??= elapsedMs;
          recordVoiceFirstSpeech(metrics, elapsedMs, bridged);
        },
      },
    };
    return { policy, linesLanguage: humanOwned ? null : language };
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
