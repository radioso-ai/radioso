import type { AppLogger } from "../../../shared/observability/logger.js";
import { errorClassOf } from "../../../shared/observability/errorClass.js";
import type { VoiceLanguageSwitchResult, VoiceSessionRef, VoiceTurnEvent, VoiceTurnInput } from "../domain.js";
import type { ClaimedOperatorReply } from "./operatorReplySpeaker.js";
import { abortWaiter, SwitchedReply, SwitchedTurns, type UnspokenSwitchReason } from "./switchedTurns.js";
import { languageOf, resolveVoiceLanguage } from "./voiceLines.js";
import {
  recordVoiceLanguageSwitch,
  recordVoiceLanguageSwitchFollowUp,
  recordVoiceTurnLanguage,
  recordVoiceTurnOutcome,
  type VoiceTurnMetricsSink,
} from "./voiceTurnMetrics.js";
import {
  applyVoiceTurnPolicy,
  withoutPhaseMarkers,
  type VoiceReplyEvent,
  type VoiceTurnLanguageSwitch,
} from "./voiceTurnPolicy.js";
import {
  CONTINUE,
  endWithoutSpeech,
  languageFields,
  storedSpeech,
  type PreparedVoicePolicy,
  type SwitchedTurn,
  type VoiceTurnRecord,
  type VoiceTurnSetting,
} from "./voiceTurnRecord.js";
import {
  cutOffAt,
  sameUtterance,
  supersededBeforeOutcome,
  type VoiceSessionMemory,
  type VoiceStoredReply,
  type VoiceTurnClaim,
} from "./voiceSessionMemory.js";

/**
 * The conversation's newest exchange, read by a switch's follow-up that finds no switched turn in
 * this process: the turn that switched runs on another instance and stores its answer there.
 */
export interface VoiceStoredReplyReader {
  /**
   * The conversation's newest user message, as its text, and the agent's reply to it once stored
   * (null until then); null when the conversation holds no user message.
   */
  newestExchange(conversation: { workspaceId: string; conversationId: string }): Promise<{ utterance: string; reply: VoiceStoredReply | null } | null>;
}

/** What a switch's follow-up finds of its answer in the conversation. */
type StoredReplyReading = { kind: "answer"; reply: VoiceStoredReply } | { kind: "pending" } | { kind: "other_utterance" };

/** The request's place in its session, when its turn may switch the call's language. */
interface SwitchingRequest {
  sessionKey: string;
  claim: VoiceTurnClaim;
}

/**
 * The steps every turn path of the voice turn service is built from, which a switch's follow-up
 * runs too: the policy, the teammate replies ahead of the answer, and the delivery that remembers
 * what the caller could hear.
 */
interface VoiceTurnSteps {
  policyFor(
    input: VoiceTurnInput,
    conversationId: string | null,
    startedAt: number,
    record: VoiceTurnRecord,
    mayBridge: () => boolean,
    switching: SwitchingRequest | null,
  ): Promise<PreparedVoicePolicy | null>;
  policyWith(
    input: VoiceTurnInput,
    setting: VoiceTurnSetting,
    startedAt: number,
    record: VoiceTurnRecord,
    mayBridge: () => boolean,
    switching: SwitchingRequest | null,
  ): PreparedVoicePolicy | null;
  claimOperatorReplies(claim: VoiceTurnClaim, record: VoiceTurnRecord, conversationId: string): Promise<ClaimedOperatorReply[]>;
  operatorReplySpeech(replies: readonly ClaimedOperatorReply[], record: VoiceTurnRecord, claim: VoiceTurnClaim): Generator<VoiceTurnEvent>;
  delivered(events: AsyncIterable<VoiceTurnEvent>, record: VoiceTurnRecord, claim: VoiceTurnClaim, sessionKey: string): AsyncGenerator<VoiceTurnEvent>;
  mayBridgeFor(record: VoiceTurnRecord, sessionKey: string, claim: VoiceTurnClaim): () => boolean;
}

interface LanguageSwitchFollowUpDependencies {
  steps: VoiceTurnSteps;
  memory: VoiceSessionMemory;
  sessions: { findConversationId(session: VoiceSessionRef): Promise<string | null> };
  ownership: { isHumanOwned(conversationId: string): Promise<boolean> };
  /** Read by a follow-up that finds no switched turn here; without it, that follow-up waits for the turn limit. */
  storedReplies?: VoiceStoredReplyReader;
  timing: { replayWindowMs: number; turnLimitMs: number; switchFollowUpPollMs: number; languageSwitchDecisionMs: number };
  newLanguageSwitchId: () => string;
  now: () => number;
  logger: Pick<AppLogger, "info" | "warn">;
  metrics?: VoiceTurnMetricsSink | null;
}

/**
 * Whether two language tags name different languages, by their primary subtags; null when that
 * cannot be told, a three-letter subtag beside a two-letter one, which may name the same language.
 */
const namesOtherLanguage = (left: string, right: string): boolean | null => {
  const [one, other] = [languageOf(left), languageOf(right)];
  if (one === other) return false;
  return one.length === 2 && other.length === 2 ? true : null;
};

/**
 * A turn's switch of the call's language and the runtime's follow-up after it: deciding the
 * switch, holding the switched turn and its running reply, speaking that reply on the follow-up,
 * reading the conversation for a follow-up nothing is held for here, and letting a switch go
 * unspoken. Each switch is one `SwitchedTurn` both requests' records share.
 */
export class LanguageSwitchFollowUps {
  /** The turns that switched the call's language, until the runtime's follow-up speaks their answer. */
  private readonly held: SwitchedTurns<SwitchedTurn>;

  constructor(private readonly deps: LanguageSwitchFollowUpDependencies) {
    // A switched turn's answer is the conversation's reply whether or not it is spoken; a follow-up
    // that comes later than a replay would finds nothing held.
    this.held = new SwitchedTurns(deps.timing.replayWindowMs, (turn, reason) => this.unspoken(turn, reason));
  }

  /** The caller said something new: a switched turn still waiting for its follow-up gets none. */
  drop(sessionKey: string): void {
    this.held.drop(sessionKey);
  }

  /**
   * The runtime's follow-up after a switch of the call's language: it speaks the answer of the
   * turn that asked for the switch, as that turn's chat turn writes it or as it was stored, with
   * that turn's phases so far, under the policy as part of that turn (its bridge and limit count
   * from the switched turn's start, its profile and routine state are the switched turn's, and its
   * lines are in the language the follow-up reports). It runs no chat turn. A follow-up for a
   * switch this process does not hold reads the answer from the conversation instead.
   */
  async *followUp(
    input: VoiceTurnInput,
    result: VoiceLanguageSwitchResult,
    claim: VoiceTurnClaim,
    record: VoiceTurnRecord,
    sessionKey: string,
    startedAt: number,
  ): AsyncGenerator<VoiceTurnEvent> {
    const taken = this.held.take(sessionKey, result.switchId, input.utterance);
    if (taken.kind === "mismatched") {
      // The session's switched turn answered another utterance; it is let go, replayable, and this
      // follow-up, which no turn here is held for, says nothing.
      record.languageSwitch = "mismatched";
      recordVoiceLanguageSwitchFollowUp(this.deps.metrics, "unheld");
      yield* endWithoutSpeech(record, "completed");
      return;
    }
    if (taken.kind === "none") {
      yield* this.unheldFollowUp(input, claim, record, sessionKey, startedAt);
      return;
    }
    const switched = taken.turn;
    const conversationId = switched.switching.conversationId;
    if (conversationId === null) {
      // The switched turn never named its conversation, so there is no answer of its to speak.
      this.unspoken(switched, "unanswered");
      yield* this.unheldFollowUp(input, claim, record, sessionKey, startedAt);
      return;
    }
    if (!taken.sameSwitch) {
      this.deps.logger.warn({
        agentId: input.session.agentId,
        vendor: input.session.vendor,
        conversationId,
      }, "Voice language switch follow-up names another switch than its session's; it speaks the session's switched turn");
    }
    record.conversationId = conversationId;
    const mayBridge = this.deps.steps.mayBridgeFor(record, sessionKey, claim);
    // Only the owner can have changed since the switched turn read the rest; a teammate who took
    // the call over meanwhile silences the bridge and the limit as on any turn.
    const [humanOwned, replies] = await Promise.all([
      this.deps.ownership.isHumanOwned(conversationId),
      this.deps.steps.claimOperatorReplies(claim, record, conversationId),
    ]);
    if (claim.supersededAt !== null) {
      // A newer request overtook this one before it spoke: the switched turn's answer goes unheard.
      record.languageSwitch = "unanswered";
      this.unspoken(switched, "unanswered");
      yield* endWithoutSpeech(record, "superseded");
      return;
    }
    record.languageSwitch = result.confirmed ? "confirmed" : "refused";
    recordVoiceLanguageSwitchFollowUp(this.deps.metrics, record.languageSwitch);
    // The switched turn's outcome is its reply's own, counted once it has one, whatever becomes of
    // this request.
    this.countOutcome(switched);
    // Whatever reached this request's caller of the answer is what chat keeps if they cut it off.
    switched.speaker = record;
    record.switched = switched;
    const prepared = this.deps.steps.policyWith(input, { ...switched.setting, humanOwned }, switched.startedAt, record, mayBridge, null);
    yield { type: "conversation", conversationId };
    yield* this.deps.steps.operatorReplySpeech(replies, record, claim);
    if (prepared?.linesLanguage) {
      record.language = prepared.linesLanguage;
    }
    const reply = switched.reply.read(claim.lost.signal);
    yield* this.deps.steps.delivered(prepared ? applyVoiceTurnPolicy(reply, prepared.policy) : withoutPhaseMarkers(reply), record, claim, sessionKey);
    record.result = supersededBeforeOutcome(claim) ? "superseded" : "completed";
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
    recordVoiceLanguageSwitchFollowUp(this.deps.metrics, "unheld");
    const conversationId = await this.deps.sessions.findConversationId(input.session);
    if (!conversationId) {
      // No turn of the session ever named a conversation, so nothing is stored to speak.
      yield* endWithoutSpeech(record, "completed");
      return;
    }
    record.conversationId = conversationId;
    const mayBridge = this.deps.steps.mayBridgeFor(record, sessionKey, claim);
    const [prepared, replies] = await Promise.all([
      this.deps.steps.policyFor(input, conversationId, startedAt, record, mayBridge, null),
      this.deps.steps.claimOperatorReplies(claim, record, conversationId),
    ]);
    if (claim.supersededAt !== null) {
      yield* endWithoutSpeech(record, "superseded");
      return;
    }
    yield { type: "conversation", conversationId };
    yield* this.deps.steps.operatorReplySpeech(replies, record, claim);
    if (prepared?.linesLanguage) {
      record.language = prepared.linesLanguage;
    }
    const reply = this.storedReplyEvents(input, conversationId, record, claim, startedAt + this.deps.timing.turnLimitMs);
    yield* this.deps.steps.delivered(prepared ? applyVoiceTurnPolicy(reply, prepared.policy) : withoutPhaseMarkers(reply), record, claim, sessionKey);
    record.result = supersededBeforeOutcome(claim) ? "superseded" : "completed";
  }

  /**
   * The agent's answer to this utterance as the conversation stores it, spoken whole once it is
   * there. Until then the turn reports a search, so the policy bridges at once, and it checks again
   * every `switchFollowUpPollMs` until `waitUntil`, the turn limit, or until the request loses its
   * caller, after which it ends with nothing.
   */
  private async *storedReplyEvents(
    input: VoiceTurnInput,
    conversationId: string,
    record: VoiceTurnRecord,
    claim: VoiceTurnClaim,
    waitUntil: number,
  ): AsyncGenerator<VoiceReplyEvent> {
    let searching = false;
    const lost = claim.lost.signal;
    const caller = abortWaiter(lost);
    try {
      for (;;) {
        if (lost.aborted) {
          yield CONTINUE;
          return;
        }
        const stored = await this.readStoredReply(input, conversationId);
        if (stored.kind === "answer") {
          record.reply = stored.reply;
          record.spokeStoredReply = true;
          yield* storedSpeech(stored.reply.text);
          yield CONTINUE;
          return;
        }
        // The caller's newest message is another utterance: this follow-up's answer will not come.
        if (stored.kind === "other_utterance" || this.deps.now() >= waitUntil) {
          yield CONTINUE;
          return;
        }
        if (!searching) {
          searching = true;
          yield { type: "phase", phase: "searching" };
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([new Promise<void>((resolve) => { timer = setTimeout(resolve, this.deps.timing.switchFollowUpPollMs); }), caller.aborted]);
        clearTimeout(timer);
      }
    } finally {
      caller.dispose();
    }
  }

  /**
   * The stored answer to this request's utterance: the conversation's newest user message must be
   * it, so an earlier exchange's answer is never spoken for it (`other_utterance`). `pending` while
   * there is none yet, or the store cannot be read now (warned, ids only).
   */
  private async readStoredReply(input: VoiceTurnInput, conversationId: string): Promise<StoredReplyReading> {
    const reader = this.deps.storedReplies;
    if (!reader) return { kind: "pending" };
    try {
      const exchange = await reader.newestExchange({ workspaceId: input.session.workspaceId, conversationId });
      if (exchange && !sameUtterance(exchange.utterance, input.utterance)) return { kind: "other_utterance" };
      return exchange?.reply ? { kind: "answer", reply: exchange.reply } : { kind: "pending" };
    } catch (error) {
      this.deps.logger.warn({
        agentId: input.session.agentId,
        vendor: input.session.vendor,
        conversationId,
        errorClass: errorClassOf(error),
      }, "Voice switch follow-up could not read the conversation's answer");
      return { kind: "pending" };
    }
  }

  /**
   * The turn's switch of the call's language: asked for when the turn's plan answers in a language
   * whose primary subtag differs from the call's (the language the request reports for the turn,
   * else the session's, else the agent's default), the runtime has not refused it on this call, and
   * no teammate's reply was spoken first. Once asked, the turn's answer is held for the runtime's
   * follow-up, and the turn ends when its chat turn does.
   */
  offerFor(
    input: VoiceTurnInput,
    setting: SwitchedTurn["setting"],
    record: VoiceTurnRecord,
    turn: { sessionKey: string; claim: VoiceTurnClaim; startedAt: number },
  ): VoiceTurnLanguageSwitch {
    const { profile } = setting;
    let switchId: string | null = null;
    return {
      decideWithinMs: this.deps.timing.languageSwitchDecisionMs,
      switchFor: (tag) => {
        // A request that lost its caller asks nothing: its follow-up would speak over the newer
        // turn. A switch the request cannot read leaves the call's language unknown.
        if (cutOffAt(turn.claim) !== null || input.languageReport === "unreadable" || record.spoken.operatorReplies.length > 0) {
          return null;
        }
        const current = resolveVoiceLanguage({ turn: input.turnLanguage, session: input.locale, agentDefault: profile.defaultLocale });
        const refusedBefore = (input.languageSwitchOffer?.refused ?? []).some((earlier) => namesOtherLanguage(earlier, tag) !== true);
        if (namesOtherLanguage(current.tag, tag) !== true || refusedBefore) {
          return null;
        }
        switchId = this.deps.newLanguageSwitchId();
        return { type: "switchLanguage", switchId, language: languageOf(tag), reason: "response_language" };
      },
      switched: (rest, phasesSeen) => {
        const reply = new SwitchedReply(rest, phasesSeen);
        const switched: SwitchedTurn = {
          input,
          switching: record,
          speaker: null,
          claim: turn.claim,
          sessionKey: turn.sessionKey,
          startedAt: turn.startedAt,
          setting,
          reply,
          unheardAt: null,
          outcomeCounted: false,
        };
        record.languageSwitch = "emitted";
        record.switched = switched;
        record.drain = reply.drained;
        recordVoiceLanguageSwitch(this.deps.metrics, "emitted");
        if (switchId !== null) {
          this.held.hold(turn.sessionKey, { switchId, utterance: input.utterance, turn: switched });
        }
      },
    };
  }

  /**
   * A switched turn whose answer no follow-up speaks. The caller heard none of it, so its exchange
   * reads as cut off when its switch left, and an identical re-request within the replay window
   * hears the answer; its outcome is counted here once its chat turn ends. Ids only.
   */
  private unspoken(turn: SwitchedTurn, reason: UnspokenSwitchReason): void {
    recordVoiceLanguageSwitch(this.deps.metrics, reason);
    turn.unheardAt = turn.claim.outcomeAt ?? this.deps.now();
    this.deps.memory.markUnheard(turn.sessionKey, turn.claim, turn.unheardAt);
    // No follow-up counts the turn's outcome and lines' language, so they are counted here, once
    // its chat turn ends, and logged with the reply's own outcome.
    this.countOutcome(turn);
    void turn.reply.drained.then(() => {
      const outcome = turn.reply.outcome();
      const record = turn.switching;
      if (record.language) {
        recordVoiceTurnLanguage(this.deps.metrics, record.language.source);
      }
      this.deps.logger.info({
        agentId: turn.input.session.agentId,
        vendor: turn.input.session.vendor,
        conversationId: record.conversationId,
        languageSwitch: reason,
        ...(outcome ? { outcome: outcome.kind } : {}),
        ...(record.handoffReason ? { handoffReason: record.handoffReason } : {}),
        ...languageFields(record.language, turn.input),
      }, "Voice language switch was not followed up");
    });
  }

  /** Counts a switched turn's outcome once, as its reply ends it, whoever speaks it or none. */
  private countOutcome(turn: SwitchedTurn): void {
    if (turn.outcomeCounted) return;
    turn.outcomeCounted = true;
    void turn.reply.drained.then(() => {
      const outcome = turn.reply.outcome();
      if (outcome) {
        recordVoiceTurnOutcome(this.deps.metrics, outcome.kind, turn.switching.handoffReason);
      }
    });
  }
}
