import type { ChatTurnHandoffReason, DeliveredReplyPart } from "../../chat/contracts/index.js";
import type { AgentVoiceSettings } from "../../agents/public.js";
import type {
  VoiceLanguageSwitchOutcome,
  VoiceTurnEvent,
  VoiceTurnInput,
  VoiceTurnLanguage,
  VoiceTurnOutcome,
} from "../domain.js";
import type { HeardSpeech } from "./heardSpeech.js";
import type { OperatorReplySpeaker } from "./operatorReplySpeaker.js";
import { splitCompleteSentences } from "./speechSegmenter.js";
import type { SwitchedReply } from "./switchedTurns.js";
import type { VoiceStoredReply, VoiceTurnClaim } from "./voiceSessionMemory.js";
import type { VoiceTurnDrain, VoiceTurnPolicy } from "./voiceTurnPolicy.js";

/** What a voice turn needs from the agent's settings. */
export interface VoiceAgentProfile {
  voice: AgentVoiceSettings;
  /** The agent's default language tag, which a turn speaks in when the request names none. */
  defaultLocale: string | null;
}

/** What a turn's policy is built from: the agent's voice profile and the conversation's state at turn start. */
export interface VoiceTurnSetting {
  profile: VoiceAgentProfile | null;
  routineActive: boolean;
  humanOwned: boolean;
}

/** The turn's policy, when the agent has voice on, with the language its lines were picked in. */
export type PreparedVoicePolicy = { policy: VoiceTurnPolicy; linesLanguage: VoiceTurnLanguage | null };

export type VoiceTurnResult = "completed" | "replayed" | "superseded" | "abandoned" | "failed";

/**
 * A piece of speech that left the turn; `reached`: it reached the runtime before the turn lost its
 * caller (cut off or hung up on), which never happens before the outcome on a response that is not
 * streamed.
 */
export interface SpokenPiece {
  text: string;
  reached: boolean;
}

/** A piece of the turn's answer, with where it ends in the answer as chat streamed it (null: unknown). */
export interface SpokenAnswerPiece extends SpokenPiece {
  writtenEnd: number | null;
}

/** What the turn's one log record reports, and what the session remembers of it. */
export interface VoiceTurnRecord {
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
  /**
   * The switch this request takes part in: the turn that asked for it (`switching`) and the
   * follow-up that speaks its answer (`speaker`) share it.
   */
  switched?: SwitchedTurn;
  /** On a follow-up that found no switched turn here: it spoke the answer it read from the conversation. */
  spokeStoredReply?: boolean;
}

/**
 * A turn that switched the call's language, held for the runtime's follow-up to speak its answer,
 * and that follow-up once it took the turn: one pairing both records read.
 */
export interface SwitchedTurn {
  input: VoiceTurnInput;
  /** The turn that asked for the switch, whose chat turn writes the answer. */
  switching: VoiceTurnRecord;
  /** The follow-up speaking the answer, once it took the turn past its supersession check. */
  speaker: VoiceTurnRecord | null;
  claim: VoiceTurnClaim;
  sessionKey: string;
  /** When the switched turn started: the follow-up's bridge and limit count from here. */
  startedAt: number;
  /** The profile and routine state the switched turn read, which its follow-up reuses. */
  setting: { profile: VoiceAgentProfile; routineActive: boolean };
  reply: SwitchedReply;
  /** When no follow-up spoke the answer, so the switched turn's exchange reads as cut off then. */
  unheardAt: number | null;
  /** The turn's outcome is counted, once, as its reply ends. */
  outcomeCounted: boolean;
}

/** The record whose chat turn wrote the request's answer: the switched turn's, for its follow-up. */
export const chatTurnOf = (record: VoiceTurnRecord): VoiceTurnRecord => record.switched?.switching ?? record;

/** The record whose request spoke the answer: the follow-up's, for a switched turn it took. */
export const speakerOf = (record: VoiceTurnRecord): VoiceTurnRecord => record.switched?.speaker ?? record;

export const emptyRecord = (operatorReplyClaims: OperatorReplySpeaker, streamsSpeech: boolean): VoiceTurnRecord => ({
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

export const CONTINUE: VoiceTurnEvent = { type: "outcome", outcome: CONTINUE_OUTCOME };

/** Ends the request with `continue` and nothing said: overtaken (`superseded`), or with nothing to say (`completed`). */
export function* endWithoutSpeech(record: VoiceTurnRecord, result: Extract<VoiceTurnResult, "superseded" | "completed">): Generator<VoiceTurnEvent> {
  record.result = result;
  record.outcome = CONTINUE_OUTCOME;
  yield CONTINUE;
}

/** A piece of the turn's answer as speech, carrying where it ends in the answer as written (null for an answer spoken again from storage). */
type AnswerSpeech = Extract<VoiceTurnEvent, { type: "speech" }> & { writtenEnd: number | null };

export const answerSpeech = (piece: { text: string; writtenEnd: number | null }, last: boolean): AnswerSpeech =>
  ({ type: "speech", text: piece.text, last, writtenEnd: piece.writtenEnd });

/** Speech of the turn's answer, as opposed to a line the turn policy speaks in its place. */
export const isAnswerSpeech = (event: VoiceTurnEvent): event is AnswerSpeech => event.type === "speech" && "writtenEnd" in event;

/** The end of a whole reply as speech: its remaining sentences, then the tail, which is the last piece. */
export function* lastSpeech(
  rest: { sentences: ReadonlyArray<{ text: string; writtenEnd: number | null }>; remainder: { text: string; writtenEnd: number | null } },
): Generator<AnswerSpeech> {
  for (const sentence of rest.sentences) {
    yield answerSpeech(sentence, false);
  }
  yield answerSpeech(rest.remainder, true);
}

/** A stored answer spoken whole, sentence by sentence: no place in a written stream to carry. */
export function* storedSpeech(text: string): Generator<AnswerSpeech> {
  const stored = splitCompleteSentences(text, { startsLine: true, final: true });
  yield* lastSpeech({
    sentences: stored.sentences.map((sentence) => ({ text: sentence, writtenEnd: null })),
    remainder: { text: stored.remainder, writtenEnd: null },
  });
}

/**
 * The turn's languages on its log line: the one its lines were picked in, when it ran with them
 * (the same turns `voice_turn_language_source_total` counts); the one the request reported, on
 * every turn that reports one; and why the newest switch the request carried was not taken. Tags
 * and closed values only.
 */
export const languageFields = (linesLanguage: VoiceTurnLanguage | undefined, input: Pick<VoiceTurnInput, "turnLanguage" | "languageReport">) => ({
  ...(linesLanguage ? { turnLanguage: linesLanguage.tag, languageSource: linesLanguage.source } : {}),
  ...(input.turnLanguage ? { reportedTurnLanguage: input.turnLanguage.tag } : {}),
  ...(input.languageReport ? { languageReport: input.languageReport } : {}),
});
