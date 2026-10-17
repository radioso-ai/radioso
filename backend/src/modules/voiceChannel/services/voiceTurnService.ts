import type {
  ChatStreamEvent,
  ChatTurnHandoffReason,
  ConversationTurnSupersession,
  OperatorReplyClaim,
  OperatorReplySpeechClaims,
  PendingOperatorReply,
} from "../../chat/contracts/index.js";
import { errorClassOf } from "../../../shared/observability/errorClass.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import { VOICE_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import { VOICE_SOURCE_CHANNEL } from "../../../shared/domain/conversationSource.js";
import type { AgentVoiceSettings } from "../../agents/public.js";
import {
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
  recordVoiceOperatorRepliesSpoken,
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
import { createSentenceCutter, splitCompleteSentences, wholeTextSpeech } from "./speechSegmenter.js";
import { hasSpokenWords } from "./speechText.js";
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

/** Durable notes on a session's previous turn, keyed to its stored reply. Never the reply's text. */
export interface VoiceTurnNotes {
  /** The vendor replayed the stored reply cut short: how much of it the caller heard. */
  replyInterrupted(note: {
    workspaceId: string;
    conversationId: string;
    assistantMessageId: string;
    heardCharacterCount: number;
    spokenCharacterCount: number;
  }): Promise<void>;
  /** An identical re-request heard the stored reply again, without a new turn. */
  replyReplayed(note: { workspaceId: string; conversationId: string; assistantMessageId: string }): Promise<void>;
  /**
   * The turn that claimed a teammate's replies spoke them and completed, so the caller heard them;
   * resolves the ids it recorded as spoken (none that another turn recorded first).
   */
  operatorRepliesSpoken(note: OperatorReplyClaim): Promise<string[]>;
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
  /**
   * Chat's teammate replies the caller has not heard yet and the claims a turn holds on them, and
   * the id each turn claims under; without it, a turn speaks none.
   */
  operatorReplies?: { claims: OperatorReplySpeechClaims; newClaimTurnId: () => string };
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
  /** The stored answer, once chat reports it. */
  reply: { messageId: string; text: string } | null;
  /**
   * What left the turn for the caller: a teammate's replies, the bridge line, and every speech
   * piece of the turn's own answer, each in order.
   */
  spoken: { operatorReplies: string[]; bridge: string | null; speech: string[] };
  /**
   * The teammate replies the turn took on: the ones it claimed and speaks ahead of its answer, and
   * the ones with no words to say; null when it read none.
   */
  operatorReplies: { claimTurnId: string; claimed: string[]; wordless: string[] } | null;
  /** How many of the claimed replies were recorded as spoken once the turn completed. */
  spokenOperatorReplies: number;
  /** The outcome the runtime received, once it left. */
  outcome: VoiceTurnOutcome | null;
  /** Why chat handed the conversation to a person on this turn; null when it did not. */
  handoffReason: ChatTurnHandoffReason | null;
  /** The reply still draining after the turn limit ended the turn's events; the turn ends with it. */
  drain?: Promise<VoiceTurnDrain>;
}

const emptyRecord = (): VoiceTurnRecord => ({
  conversationId: null,
  speechPieceCount: 0,
  result: "abandoned",
  chatPrepared: false,
  chatReplied: false,
  reply: null,
  spoken: { operatorReplies: [], bridge: null, speech: [] },
  operatorReplies: null,
  spokenOperatorReplies: 0,
  outcome: null,
  handoffReason: null,
});

const CONTINUE_OUTCOME: VoiceTurnOutcome = { kind: "continue" };

const NO_OPERATOR_REPLIES: readonly PendingOperatorReply[] = [];

/** A teammate's reply the turn claimed, as the speech pieces it is spoken in. */
interface ClaimedOperatorReply {
  messageId: string;
  speech: string[];
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
  /** Agents already warned about a bridge line shorter than their runtime speaks on its own. */
  private readonly shortBridgeWarned = new Set<string>();

  constructor(private readonly dependencies: VoiceTurnServiceDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.timing = dependencies.timing ?? VOICE_BEHAVIOR;
    this.memory = new VoiceSessionMemory(this.timing);
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
    const record = emptyRecord();
    let failure: unknown;
    let firstTurn: FirstTurn | undefined;

    try {
      this.noteInterruptedReply(input, sessionKey);
      const replay = this.memory.replayFor(sessionKey, input.utterance, startedAt);
      if (replay) {
        // The teammate's replies the caller has not heard come before the answer heard again.
        record.conversationId = replay.conversationId;
        const replies = await this.claimOperatorReplies(input, replay.conversationId, record, await this.pendingOperatorReplies(input, replay.conversationId));
        yield { type: "conversation", conversationId: replay.conversationId };
        yield* this.operatorReplySpeech(replies, record);
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
      const [policy, pending] = claim.supersededAt === null
        ? await Promise.all([
            this.policyFor(input, sessionClaim.conversationId, startedAt, record, mayBridge),
            this.pendingOperatorReplies(input, sessionClaim.conversationId),
          ])
        : [null, NO_OPERATOR_REPLIES];
      const replies = claim.supersededAt === null && sessionClaim.conversationId
        ? await this.claimOperatorReplies(input, sessionClaim.conversationId, record, pending)
        : [];
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
        yield* this.operatorReplySpeech(replies, record);
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
      const repliesSettled = this.settleOperatorReplies(input, record, claim);
      const finish = (): void => {
        this.releaseFirstTurn(input.session, firstTurn);
        this.memory.settle(sessionKey, claim, this.now(), this.exchangeOf(input, record, claim));
        if (repliesSettled) {
          void repliesSettled.then(() => this.logTurn(input, record, startedAt, failure));
        } else {
          this.logTurn(input, record, startedAt, failure);
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
        record.spoken.speech.push(event.text);
      } else if (event.type === "outcome") {
        claim.outcomeAt ??= this.now();
        record.outcome = event.outcome;
      }
      yield event;
    }
  }

  /**
   * Claims the pending teammate replies that have words to say, so no other turn speaks them,
   * whichever instance runs it; a reply another turn claimed first is left to that turn. A claim
   * that cannot be written leaves the replies to a later turn.
   */
  private async claimOperatorReplies(
    input: VoiceTurnInput,
    conversationId: string,
    record: VoiceTurnRecord,
    pending: readonly PendingOperatorReply[],
  ): Promise<ClaimedOperatorReply[]> {
    const source = this.dependencies.operatorReplies;
    if (!source || pending.length === 0) {
      return [];
    }
    const spoken = pending.map((reply) => ({ messageId: reply.messageId, speech: wholeTextSpeech(reply.text) }));
    const speakable = spoken.filter((reply) => reply.speech.length > 0);
    const taken = { claimTurnId: source.newClaimTurnId(), claimed: [] as string[], wordless: spoken.filter((reply) => reply.speech.length === 0).map((reply) => reply.messageId) };
    record.operatorReplies = taken;
    if (speakable.length === 0) {
      return [];
    }
    try {
      const claimed = new Set(await source.claims.claimOperatorReplies({
        workspaceId: input.session.workspaceId,
        conversationId,
        messageIds: speakable.map((reply) => reply.messageId),
        claimTurnId: taken.claimTurnId,
      }));
      const replies = speakable.filter((reply) => claimed.has(reply.messageId));
      taken.claimed = replies.map((reply) => reply.messageId);
      return replies;
    } catch (error) {
      this.warnOperatorRepliesUnsettled(input, conversationId, "claim", error);
      return [];
    }
  }

  /** The teammate's claimed replies, spoken ahead of the turn's own answer, in the order they were written. */
  private *operatorReplySpeech(replies: readonly ClaimedOperatorReply[], record: VoiceTurnRecord): Generator<VoiceTurnEvent> {
    for (const reply of replies) {
      for (const text of reply.speech) {
        record.speechPieceCount += 1;
        record.spoken.operatorReplies.push(text);
        yield { type: "speech", text, last: false };
      }
    }
  }

  /**
   * The caller heard the teammate's claimed replies when the turn's outcome left before a newer
   * request overtook it or the runtime hung up: the note records them as spoken, and only then
   * are they counted. Otherwise they go back to pending for the next turn. Replies with no words
   * to say are skipped. Null when the turn took on no replies.
   */
  private settleOperatorReplies(input: VoiceTurnInput, record: VoiceTurnRecord, claim: VoiceTurnClaim): Promise<void> | null {
    const taken = record.operatorReplies;
    const source = this.dependencies.operatorReplies;
    const { conversationId } = record;
    if (!taken || !source || !conversationId) {
      return null;
    }
    const conversation = { workspaceId: input.session.workspaceId, conversationId };
    const writes: Array<Promise<unknown>> = [];
    if (taken.wordless.length > 0) {
      writes.push(this.settleWrite(input, conversationId, "skip", source.claims.skipOperatorReplies({ ...conversation, messageIds: taken.wordless })));
    }
    if (taken.claimed.length > 0) {
      const claimed: OperatorReplyClaim = { ...conversation, messageIds: taken.claimed, claimTurnId: taken.claimTurnId };
      const heard = claim.outcomeAt !== null && cutOffAt(claim) === null;
      writes.push(heard
        ? this.recordOperatorRepliesSpoken(input, record, claimed)
        : this.settleWrite(input, conversationId, "release", source.claims.releaseOperatorReplies(claimed)));
    }
    return Promise.all(writes).then(() => undefined);
  }

  private async recordOperatorRepliesSpoken(input: VoiceTurnInput, record: VoiceTurnRecord, claimed: OperatorReplyClaim): Promise<void> {
    const { notes } = this.dependencies;
    if (!notes) {
      return;
    }
    try {
      const marked = await withinNoteTimeout(notes.operatorRepliesSpoken(claimed));
      record.spokenOperatorReplies = marked.length;
      if (marked.length > 0) {
        recordVoiceOperatorRepliesSpoken(this.dependencies.metrics, marked.length);
      }
    } catch (error) {
      // The claim stays until it expires; a later turn then speaks the replies again.
      this.warnNoteFailed(input, claimed.conversationId, error);
    }
  }

  /** A skip or a release, bounded like a note; one that fails leaves the claim to expire. */
  private settleWrite(input: VoiceTurnInput, conversationId: string, step: "skip" | "release", write: Promise<unknown>): Promise<void> {
    return withinNoteTimeout(write).then(
      () => undefined,
      (error: unknown) => this.warnOperatorRepliesUnsettled(input, conversationId, step, error),
    );
  }

  private warnOperatorRepliesUnsettled(input: VoiceTurnInput, conversationId: string, step: "claim" | "skip" | "release", error: unknown): void {
    this.dependencies.logger.warn({
      agentId: input.session.agentId,
      vendor: input.session.vendor,
      conversationId,
      step,
      errorClass: errorClassOf(error),
    }, "Voice turn could not update the teammate's pending replies");
  }

  /**
   * The teammate replies the conversation holds that the caller has not heard. A read that fails
   * leaves them pending, so the turn runs as chat answers it and the next turn speaks them.
   */
  private async pendingOperatorReplies(input: VoiceTurnInput, conversationId: string | null): Promise<readonly PendingOperatorReply[]> {
    const source = this.dependencies.operatorReplies;
    if (!source || !conversationId) {
      return NO_OPERATOR_REPLIES;
    }
    try {
      return await source.claims.pendingOperatorReplies({ workspaceId: input.session.workspaceId, conversationId });
    } catch (error) {
      this.dependencies.logger.warn({
        agentId: input.session.agentId,
        vendor: input.session.vendor,
        conversationId,
        errorClass: errorClassOf(error),
      }, "Voice turn could not read the teammate's pending replies; they wait for the next turn");
      return NO_OPERATOR_REPLIES;
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
  private noteInterruptedReply(input: VoiceTurnInput, sessionKey: string): void {
    if (input.heardUntil === undefined) {
      return;
    }
    const reservation = this.memory.reserveInterruption(sessionKey, input.heardUntil);
    if (!reservation) {
      return;
    }
    const { interruption } = reservation;
    const recorded = (): void => {
      reservation.recorded();
      recordVoiceReplyInterrupted(this.dependencies.metrics);
      this.dependencies.logger.info({
        agentId: input.session.agentId,
        vendor: input.session.vendor,
        ...interruption,
      }, "Voice reply was interrupted");
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

  private logTurn(input: VoiceTurnInput, record: VoiceTurnRecord, startedAt: number, failure: unknown): void {
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
      durationMs: this.now() - startedAt,
      speechPieceCount: record.speechPieceCount,
      ...(record.spokenOperatorReplies > 0 ? { spokenOperatorReplies: record.spokenOperatorReplies } : {}),
      ...(record.outcome ? { outcome: record.outcome.kind } : {}),
      ...(record.handoffReason ? { handoffReason: record.handoffReason } : {}),
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
          // A newer turn on the conversation superseded this one and owns the reply now.
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
