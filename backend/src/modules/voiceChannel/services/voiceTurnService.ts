import { randomUUID } from "node:crypto";

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
  type VoiceLanguageSwitchOutcome,
  type VoiceLanguageSwitchResult,
  type VoiceSessionRef,
  type VoiceSessionStartLookup,
  type VoiceTurnEvent,
  type VoiceTurnInput,
  type VoiceTurnLanguage,
  type VoiceTurnOutcome,
  type VoiceTurnPort,
} from "../domain.js";
import { chooseVoiceTurnLines, languageOf, resolveVoiceLanguage } from "./voiceLines.js";
import {
  recordVoiceBridgeDue,
  recordVoiceFirstSpeech,
  recordVoiceLanguageSwitch,
  recordVoiceReplyInterrupted,
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
  type VoiceTurnDrain,
  type VoiceTurnLanguageSwitch,
  type VoiceTurnPhase,
  type VoiceTurnPolicy,
} from "./voiceTurnPolicy.js";
import { SwitchedReply, SwitchedTurns, type UnspokenSwitchReason } from "./switchedTurns.js";
import { OperatorReplySpeaker, type ClaimedOperatorReply, type OperatorReplySpeakerDependencies } from "./operatorReplySpeaker.js";
import { createSentenceCutter, splitCompleteSentences } from "./speechSegmenter.js";
import { hasSpokenWords, spokenLength } from "./speechText.js";
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
  /**
   * The language the request reports as news on this turn (`VoiceTurnInput.turnLanguage` with
   * `isNew`), as chat's locale hint. Absent otherwise: chat then reads the caller's
   * language from what they said, so neither the session's locale nor a switch an earlier turn made
   * holds a caller who moved on to it.
   */
  userExpectedLocale?: string;
  /** The stream reports the language the turn answers in before the answer, so the turn can switch the call's. */
  reportResponseLanguage: true;
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
  switchFollowUpPollMs: number;
}

/**
 * The agent's stored answers, read by a switch's follow-up that finds no switched turn in this
 * process: the turn that switched runs on another instance and stores its answer there.
 */
export interface VoiceStoredReplyReader {
  /** The agent's reply to the conversation's newest user message, once stored; null until then. */
  replyToNewestUtterance(conversation: { workspaceId: string; conversationId: string }): Promise<VoiceStoredReply | null>;
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
  /** Mints the id of each switch of the call's language a turn asks the runtime for. */
  newLanguageSwitchId?: () => string;
  /** Read by a switch's follow-up that finds no switched turn here; without it, that follow-up waits for the turn limit. */
  storedReplies?: VoiceStoredReplyReader;
  /** Overrides `VOICE_BEHAVIOR`; tests only. */
  timing?: Partial<VoiceTurnTiming>;
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
  /** The language the turn's lines were picked in, once the turn runs with them. */
  language?: VoiceTurnLanguage;
  /** Chat reported progress, so it stored the turn's user message. */
  chatPrepared: boolean;
  /** Chat began the reply, so a newer utterance no longer replaces the user message. */
  chatReplied: boolean;
  /** The stored answer, once chat reports it: the whole reply, or the heard part of one cut off mid-stream. */
  reply: VoiceStoredReply | null;
  /** The answer as chat streamed it so far, before it was cut into speech. */
  written: string;
  /**
   * What left the turn for the caller, each in order: a teammate's replies' pieces, the bridge
   * line, the pieces of the turn's own answer, and the fallback line spoken in the answer's place.
   */
  spoken: { operatorReplies: SpokenPiece[]; bridge: string | null; answer: SpokenAnswerPiece[]; fallback: string | null };
  /** The response streams its speech, so each piece reaches the runtime as it leaves. */
  streamsSpeech: boolean;
  /**
   * What the request that overtook this turn reported the caller heard of it (the runtime's own
   * record of what it played, cut where the caller spoke over it), measured once against what had
   * reached the runtime by then; `heard` is null when the report does not match it.
   */
  reported?: { text: string; heard: HeardSpeech | null };
  /** What chat was told reached the caller of a reply cut off mid-stream, once it asked. */
  deliveredPart: DeliveredReplyPart | null;
  /** The teammate replies the turn claims, speaks ahead of its answer, and settles. */
  operatorReplyClaims: OperatorReplySpeaker;
  /** The outcome the runtime received, once it left. */
  outcome: VoiceTurnOutcome | null;
  /** Why chat handed the conversation to a person on this turn; null when it did not. */
  handoffReason: ChatTurnHandoffReason | null;
  /**
   * The reply still running after the turn's events ended: drained after the turn limit, or written
   * for the follow-up of a turn that switched the call's language. The turn ends with it.
   */
  drain?: Promise<VoiceTurnDrain>;
  /** Where the language switch this request asked for, or followed up, stands. */
  languageSwitch?: VoiceLanguageSwitchOutcome;
  /** On a turn that switched the call's language: the follow-up request speaking its answer, once it came. */
  speaker?: VoiceTurnRecord;
  /** On the runtime's follow-up after a switch: the turn whose answer it speaks, and that turn's running reply. */
  speaksFor?: { record: VoiceTurnRecord; reply: SwitchedReply };
  /** On a follow-up that found no switched turn here: it spoke the answer it read from the conversation. */
  spokeStoredReply?: boolean;
  /** On a turn that switched: when no follow-up spoke its answer, so its exchange reads as cut off then. */
  unheardAt?: number;
}

/** What a turn's policy is built from: the agent's voice profile and the conversation's state at turn start. */
interface VoiceTurnSetting {
  profile: VoiceAgentProfile | null;
  routineActive: boolean;
  humanOwned: boolean;
}

/** A turn that switched the call's language, held for the runtime's follow-up to speak its answer. */
interface SwitchedTurn {
  input: VoiceTurnInput;
  record: VoiceTurnRecord;
  claim: VoiceTurnClaim;
  sessionKey: string;
  /** When the switched turn started: the follow-up's bridge and limit count from here. */
  startedAt: number;
  /** The profile and routine state the switched turn read, which its follow-up reuses. */
  setting: { profile: VoiceAgentProfile; routineActive: boolean };
  reply: SwitchedReply;
  /** The turn's outcome was counted, by the follow-up that delivered it or when none spoke it. */
  outcomeCounted: boolean;
}

const emptyRecord = (operatorReplyClaims: OperatorReplySpeaker, streamsSpeech: boolean): VoiceTurnRecord => ({
  conversationId: null,
  speechPieceCount: 0,
  result: "abandoned",
  chatPrepared: false,
  chatReplied: false,
  reply: null,
  written: "",
  spoken: { operatorReplies: [], bridge: null, answer: [], fallback: null },
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

/**
 * A piece of speech that left the turn; `reached`: it reached the runtime before the turn lost its
 * caller (cut off or hung up on), which never happens before the outcome on a response that is not
 * streamed.
 */
interface SpokenPiece {
  text: string;
  reached: boolean;
}

/** A piece of the turn's answer, with where it ends in the answer as chat streamed it (null: unknown). */
interface SpokenAnswerPiece extends SpokenPiece {
  writtenEnd: number | null;
}

/** A piece of the turn's answer as speech, carrying where it ends in the answer as written (null for an answer spoken again from storage). */
type AnswerSpeech = Extract<VoiceTurnEvent, { type: "speech" }> & { writtenEnd: number | null };

const answerSpeech = (piece: { text: string; writtenEnd: number | null }, last: boolean): AnswerSpeech => ({ type: "speech", text: piece.text, last, writtenEnd: piece.writtenEnd });

/** Speech of the turn's answer, as opposed to a line the turn policy speaks in its place. */
const isAnswerSpeech = (event: VoiceTurnEvent): event is AnswerSpeech => event.type === "speech" && "writtenEnd" in event;

/** The end of a whole reply as speech: its remaining sentences, then the tail, which is the last piece. */
function* lastSpeech(
  rest: { sentences: ReadonlyArray<{ text: string; writtenEnd: number | null }>; remainder: { text: string; writtenEnd: number | null } },
): Generator<AnswerSpeech> {
  for (const sentence of rest.sentences) {
    yield answerSpeech(sentence, false);
  }
  yield answerSpeech(rest.remainder, true);
}

/** The speech that reached the runtime before the turn lost its caller, in order. */
const reachedSpeechOf = (record: VoiceTurnRecord): ReachedSpeech => ({
  operatorReplies: record.spoken.operatorReplies.filter((piece) => piece.reached).map((piece) => piece.text),
  bridge: record.spoken.bridge,
  answer: record.spoken.answer.filter((piece) => piece.reached).map((piece) => piece.text),
});

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

/**
 * The turn's languages on its log line: the one its lines were picked in, when it ran with them
 * (the same turns `voice_turn_language_source_total` counts); the one the request reported, on
 * every turn that reports one; and why the newest switch the request carried was not taken. Tags
 * and closed values only.
 */
const languageFields = (linesLanguage: VoiceTurnLanguage | undefined, input: Pick<VoiceTurnInput, "turnLanguage" | "languageReport">) => ({
  ...(linesLanguage ? { turnLanguage: linesLanguage.tag, languageSource: linesLanguage.source } : {}),
  ...(input.turnLanguage ? { reportedTurnLanguage: input.turnLanguage.tag } : {}),
  ...(input.languageReport ? { languageReport: input.languageReport } : {}),
});

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
  /** The turns that switched the call's language, until the runtime's follow-up speaks their answer. */
  private readonly switchedTurns: SwitchedTurns<SwitchedTurn>;
  private readonly newLanguageSwitchId: () => string;

  constructor(private readonly dependencies: VoiceTurnServiceDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.timing = { ...VOICE_BEHAVIOR, ...dependencies.timing };
    this.memory = new VoiceSessionMemory(this.timing);
    this.newLanguageSwitchId = dependencies.newLanguageSwitchId ?? randomUUID;
    // A switched turn's answer is the conversation's reply whether or not it is spoken; a follow-up
    // that comes later than a replay would finds nothing to speak.
    this.switchedTurns = new SwitchedTurns(this.timing.replayWindowMs, (turn, reason) => this.switchUnspoken(turn, reason));
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
      if (input.languageSwitchResult) {
        yield* this.switchFollowUp(input, input.languageSwitchResult, claim, record, sessionKey, startedAt);
        return;
      }
      // The caller said something new: a switched turn still waiting for its follow-up gets none.
      this.switchedTurns.drop(sessionKey);
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
      const [prepared, replies] = claim.supersededAt === null
        ? await Promise.all([
            this.policyFor(input, sessionClaim.conversationId, startedAt, record, mayBridge, { sessionKey, claim }),
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
      if (prepared?.linesLanguage) {
        // The turn runs with its lines from here on, so their language is the turn's to report.
        record.language = prepared.linesLanguage;
      }
      const reply = this.replyEvents(input, sessionClaim, record, signal, sessionKey);
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

  /**
   * The runtime's follow-up after a switch of the call's language: it speaks the answer of the
   * turn that asked for the switch, as that turn's chat turn writes it or as it was stored, with
   * that turn's phases so far, under the policy as part of that turn (its bridge and limit count
   * from the switched turn's start, its profile and routine state are the switched turn's, and its
   * lines are in the language the follow-up reports). It runs no chat turn. A follow-up for a
   * switch this process does not hold reads the answer from the conversation instead.
   */
  private async *switchFollowUp(
    input: VoiceTurnInput,
    result: VoiceLanguageSwitchResult,
    claim: VoiceTurnClaim,
    record: VoiceTurnRecord,
    sessionKey: string,
    startedAt: number,
  ): AsyncGenerator<VoiceTurnEvent> {
    const taken = this.switchedTurns.take(sessionKey, result.switchId, input.utterance);
    if (taken.kind === "none") {
      yield* this.unheldFollowUp(input, claim, record, sessionKey, startedAt);
      return;
    }
    const switched = taken.turn;
    const conversationId = switched.record.conversationId;
    if (conversationId === null) {
      // The switched turn never named its conversation, so there is no answer of its to speak.
      this.switchUnspoken(switched, "unanswered");
      yield* this.unheldFollowUp(input, claim, record, sessionKey, startedAt);
      return;
    }
    if (!taken.sameSwitch) {
      this.dependencies.logger.warn({
        agentId: input.session.agentId,
        vendor: input.session.vendor,
        conversationId: switched.record.conversationId,
      }, "Voice language switch follow-up names another switch than its session's; it speaks the session's switched turn");
    }
    record.conversationId = conversationId;
    const mayBridge = (): boolean => record.spoken.operatorReplies.length === 0 && this.memory.mayBridge(sessionKey, claim, this.now());
    // Only the owner can have changed since the switched turn read the rest; a teammate who took
    // the call over meanwhile silences the bridge and the limit as on any turn.
    const [humanOwned, replies] = await Promise.all([
      this.dependencies.ownership.isHumanOwned(conversationId),
      this.claimOperatorReplies(claim, record, conversationId),
    ]);
    if (claim.supersededAt !== null) {
      // A newer request overtook this one before it spoke: the switched turn's answer goes unheard.
      record.languageSwitch = "unanswered";
      this.switchUnspoken(switched, "unanswered");
      record.result = "superseded";
      record.outcome = CONTINUE_OUTCOME;
      yield CONTINUE;
      return;
    }
    record.languageSwitch = result.confirmed ? "confirmed" : "refused";
    recordVoiceLanguageSwitch(this.dependencies.metrics, record.languageSwitch);
    // This request delivers the switched turn's outcome, so its log counts it.
    switched.outcomeCounted = true;
    // Whatever reached this request's caller of the answer is what chat keeps if they cut it off.
    switched.record.speaker = record;
    record.speaksFor = { record: switched.record, reply: switched.reply };
    const prepared = this.policyWith(input, { ...switched.setting, humanOwned }, switched.startedAt, record, mayBridge, null);
    yield { type: "conversation", conversationId };
    yield* this.operatorReplySpeech(replies, record, claim);
    if (prepared?.linesLanguage) {
      record.language = prepared.linesLanguage;
    }
    const reply = switched.reply.read();
    yield* this.delivered(prepared ? applyVoiceTurnPolicy(reply, prepared.policy) : withoutPhaseMarkers(reply), record, claim, sessionKey);
    const overtaken = claim.supersededAt !== null && (claim.outcomeAt === null || claim.supersededAt <= claim.outcomeAt);
    record.result = overtaken ? "superseded" : "completed";
  }

  /**
   * A switch's follow-up this process holds no switched turn for: the turn that switched runs on
   * another instance, or was let go. The caller is not left silent: the follow-up bridges in the
   * language it reports and speaks the agent's answer once the conversation stores it, or the
   * fallback line at the turn limit.
   */
  private async *unheldFollowUp(
    input: VoiceTurnInput,
    claim: VoiceTurnClaim,
    record: VoiceTurnRecord,
    sessionKey: string,
    startedAt: number,
  ): AsyncGenerator<VoiceTurnEvent> {
    record.languageSwitch = "unheld";
    recordVoiceLanguageSwitch(this.dependencies.metrics, "unheld");
    const conversationId = await this.dependencies.sessions.findConversationId(input.session);
    if (!conversationId) {
      record.result = "completed";
      record.outcome = CONTINUE_OUTCOME;
      yield CONTINUE;
      return;
    }
    record.conversationId = conversationId;
    const mayBridge = (): boolean => record.spoken.operatorReplies.length === 0 && this.memory.mayBridge(sessionKey, claim, this.now());
    const [prepared, replies] = await Promise.all([
      this.policyFor(input, conversationId, startedAt, record, mayBridge, null),
      this.claimOperatorReplies(claim, record, conversationId),
    ]);
    if (claim.supersededAt !== null) {
      record.result = "superseded";
      record.outcome = CONTINUE_OUTCOME;
      yield CONTINUE;
      return;
    }
    yield { type: "conversation", conversationId };
    yield* this.operatorReplySpeech(replies, record, claim);
    if (prepared?.linesLanguage) {
      record.language = prepared.linesLanguage;
    }
    const reply = this.storedReplyEvents(input, conversationId, record, startedAt + this.timing.turnLimitMs);
    yield* this.delivered(prepared ? applyVoiceTurnPolicy(reply, prepared.policy) : withoutPhaseMarkers(reply), record, claim, sessionKey);
    const overtaken = claim.supersededAt !== null && (claim.outcomeAt === null || claim.supersededAt <= claim.outcomeAt);
    record.result = overtaken ? "superseded" : "completed";
  }

  /**
   * The agent's answer as the conversation stores it, spoken whole once it is there. Until then
   * the turn reports a search, so the policy bridges at once, and it checks again every
   * `switchFollowUpPollMs` until `waitUntil`, the turn limit, after which it ends with nothing.
   */
  private async *storedReplyEvents(
    input: VoiceTurnInput,
    conversationId: string,
    record: VoiceTurnRecord,
    waitUntil: number,
  ): AsyncGenerator<VoiceReplyEvent> {
    let searching = false;
    for (;;) {
      const stored = await this.readStoredReply(input, conversationId);
      if (stored) {
        record.reply = stored;
        record.spokeStoredReply = true;
        const sentences = splitCompleteSentences(stored.text, { startsLine: true, final: true });
        yield* lastSpeech({
          sentences: sentences.sentences.map((text) => ({ text, writtenEnd: null })),
          remainder: { text: sentences.remainder, writtenEnd: null },
        });
        yield CONTINUE;
        return;
      }
      if (this.now() >= waitUntil) {
        yield CONTINUE;
        return;
      }
      if (!searching) {
        searching = true;
        yield { type: "phase", phase: "searching" };
      }
      await new Promise((resolve) => setTimeout(resolve, this.timing.switchFollowUpPollMs));
    }
  }

  /** The stored answer, or null when there is none yet or the store cannot be read now (warned, ids only). */
  private async readStoredReply(input: VoiceTurnInput, conversationId: string): Promise<VoiceStoredReply | null> {
    const reader = this.dependencies.storedReplies;
    if (!reader) return null;
    try {
      return await reader.replyToNewestUtterance({ workspaceId: input.session.workspaceId, conversationId });
    } catch (error) {
      this.dependencies.logger.warn({
        agentId: input.session.agentId,
        vendor: input.session.vendor,
        conversationId,
        errorClass: errorClassOf(error),
      }, "Voice switch follow-up could not read the conversation's answer");
      return null;
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
    const stored = splitCompleteSentences(exchange.reply.text, { startsLine: true, final: true });
    yield* lastSpeech({
      sentences: stored.sentences.map((text) => ({ text, writtenEnd: null })),
      remainder: { text: stored.remainder, writtenEnd: null },
    });
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
    // A switch's follow-up speaks the answer the switched turn's chat turn wrote and stored, or
    // one it read from the conversation.
    const chatTurn = record.speaksFor?.record ?? record;
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
      cutOffAt: cutOffAt(claim) ?? record.unheardAt ?? null,
    };
  }

  private logTurn(input: VoiceTurnInput, record: VoiceTurnRecord, startedAt: number, finishedAt: number, failure: unknown): void {
    const { metrics, logger } = this.dependencies;
    const spokenTexts = [...record.spoken.operatorReplies, ...record.spoken.answer].map((piece) => piece.text).concat(record.spoken.fallback ?? []);
    const supersededAt = spokenTexts.some((text) => text.length > 0) ? "after_speech" : "before_speech";
    if (record.result === "superseded") {
      recordVoiceTurnSuperseded(metrics, supersededAt);
    }
    // A turn that switched the call's language counts neither its outcome nor its lines' language:
    // the follow-up that speaks its answer counts both, and a switch no follow-up spoke counts its
    // outcome when it is let go. A follow-up that found no switched turn counts no outcome either.
    const switchedOnly = record.languageSwitch !== undefined && record.languageSwitch !== "confirmed" && record.languageSwitch !== "refused";
    const handoffReason = record.speaksFor?.record.handoffReason ?? record.handoffReason;
    if (record.outcome && !switchedOnly) {
      recordVoiceTurnOutcome(metrics, record.outcome.kind, handoffReason);
    }
    if (record.language && record.languageSwitch !== "emitted") {
      recordVoiceTurnLanguage(metrics, record.language.source);
    }
    // A failure of the switched turn's reply is that turn's to report, once.
    const failedWithSwitchedTurn = record.result === "failed" && record.speaksFor?.reply.failedWith(failure) === true;
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
      ...(handoffReason ? { handoffReason } : {}),
      ...((record.speaksFor?.record ?? record).reply?.partial ? { storedPartialReply: true } : {}),
      ...record.policy,
      ...languageFields(record.language, input),
      ...(record.languageSwitch ? { languageSwitch: record.languageSwitch } : {}),
    };
    if (failedWithSwitchedTurn) {
      logger.info(fields, "Voice language switch follow-up ended with its switched turn's failure");
    } else if (record.result === "failed") {
      logger.warn({ ...fields, errorClass: errorClassOf(failure) }, "Voice turn failed");
    } else if (record.languageSwitch === "unheld") {
      // The switched turn runs elsewhere, or was let go: the caller heard its stored answer, or the fallback line.
      logger.warn(fields, "Voice language switch follow-up found no switched turn here");
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
        ...(input.turnLanguage?.isNew ? { userExpectedLocale: input.turnLanguage.tag } : {}),
        sourceChannel: VOICE_SOURCE_CHANNEL,
        channelContext: channelContextFor(input),
        supersession: "latest_input_wins",
        reportResponseLanguage: true,
        deliveredReply: () => {
          // A switched turn's answer reaches its caller through the runtime's follow-up request.
          record.deliveredPart = this.deliveredReplyPart(input, record.speaker ?? record, record.written);
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
  ): Promise<{ policy: VoiceTurnPolicy; linesLanguage: VoiceTurnLanguage | null } | null> {
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
  ): { policy: VoiceTurnPolicy; linesLanguage: VoiceTurnLanguage | null } | null {
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
    const outcome = { bridged: false, turnLimitReached: false, fallbackSpoken: false };
    record.policy = outcome;
    const { metrics } = this.dependencies;
    // Only the agent's own answers switch: a person who owns the conversation answers in theirs.
    const languageSwitch = switching !== null && input.languageSwitchOffer && profile.voice.languageSwitching === true && !humanOwned
      ? this.languageSwitchFor(input, { profile, routineActive }, record, { ...switching, startedAt })
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
        firstSpeech: (elapsedMs, bridged) => recordVoiceFirstSpeech(metrics, elapsedMs, bridged),
      },
    };
    return { policy, linesLanguage: humanOwned ? null : language };
  }

  /**
   * The turn's switch of the call's language: asked for when the turn's plan answers in a language
   * whose primary subtag differs from the call's (the language the request reports for the turn,
   * else the session's, else the agent's default), the runtime has not refused it on this call, and
   * no teammate's reply was spoken first. Once asked, the turn's answer is held for the runtime's
   * follow-up, and the turn ends when its chat turn does.
   */
  private languageSwitchFor(
    input: VoiceTurnInput,
    setting: SwitchedTurn["setting"],
    record: VoiceTurnRecord,
    turn: { sessionKey: string; claim: VoiceTurnClaim; startedAt: number },
  ): VoiceTurnLanguageSwitch {
    const { profile } = setting;
    let switchId: string | null = null;
    return {
      switchFor: (tag) => {
        const language = languageOf(tag);
        const current = resolveVoiceLanguage({ turn: input.turnLanguage, session: input.locale, agentDefault: profile.defaultLocale });
        const refused = (input.languageSwitchOffer?.refused ?? []).some((earlier) => languageOf(earlier) === language);
        if (language.length === 0 || refused || languageOf(current.tag) === language || record.spoken.operatorReplies.length > 0) {
          return null;
        }
        switchId = this.newLanguageSwitchId();
        return { type: "switchLanguage", switchId, language, reason: "response_language" };
      },
      switched: (rest, phasesSeen) => {
        const reply = new SwitchedReply(rest, phasesSeen);
        record.languageSwitch = "emitted";
        record.drain = reply.drained;
        recordVoiceLanguageSwitch(this.dependencies.metrics, "emitted");
        if (switchId !== null) {
          this.switchedTurns.hold(turn.sessionKey, {
            switchId,
            utterance: input.utterance,
            turn: { input, record, claim: turn.claim, sessionKey: turn.sessionKey, startedAt: turn.startedAt, setting, reply, outcomeCounted: false },
          });
        }
      },
    };
  }

  /**
   * A switched turn whose answer no follow-up speaks. The caller heard none of it, so its exchange
   * reads as cut off when its switch left, and an identical re-request within the replay window
   * hears the answer; its outcome is counted here once its chat turn ends. Ids only.
   */
  private switchUnspoken(turn: SwitchedTurn, reason: UnspokenSwitchReason): void {
    recordVoiceLanguageSwitch(this.dependencies.metrics, reason);
    this.dependencies.logger.info({
      agentId: turn.input.session.agentId,
      vendor: turn.input.session.vendor,
      conversationId: turn.record.conversationId,
      languageSwitch: reason,
    }, "Voice language switch was not followed up");
    turn.record.unheardAt = turn.claim.outcomeAt ?? this.now();
    this.memory.markUnheard(turn.sessionKey, turn.claim, turn.record.unheardAt);
    void turn.reply.drained.then(() => {
      const outcome = turn.reply.outcome();
      if (!turn.outcomeCounted && outcome) {
        turn.outcomeCounted = true;
        recordVoiceTurnOutcome(this.dependencies.metrics, outcome.kind, turn.record.handoffReason);
      }
    });
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
