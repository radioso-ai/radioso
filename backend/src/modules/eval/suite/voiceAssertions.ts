import type { VoiceTurnOutcome, VoiceTurnSummary } from "../../voiceChannel/public.js";
import type { AssertionVerdictStatus } from "../domain/types.js";
import type { ConversationQualityCase } from "./caseSchema.js";
import type { ConversationQualityObservedOutput } from "./observedOutput.js";

/** What a piece the caller heard was: the agent's bridge line, its fallback line, or anything else said. */
export const VOICE_PIECE_KINDS = ["bridge", "speech", "fallback"] as const;

export type VoicePieceKind = (typeof VOICE_PIECE_KINDS)[number];

export type VoiceOutcomeKind = VoiceTurnOutcome["kind"];

/** Every outcome kind the voice channel sends, once each; a kind it adds fails to compile here. */
const OUTCOME_KINDS: Record<VoiceOutcomeKind, true> = { continue: true, callback_requested: true };

export const VOICE_OUTCOME_KINDS = Object.keys(OUTCOME_KINDS) as [VoiceOutcomeKind, ...VoiceOutcomeKind[]];

/** What a field of the turn's record must be: a value (null included), or absent from the record. */
type VoiceTurnRecordExpectation = string | number | boolean | null | { absent: true };

/**
 * One voice turn as a voice runtime received it on the wire, read by the runner: the pieces it
 * heard in order, with when each arrived, and the outcome the response named. Times are ms since
 * the request left; the deterministic half reads them off a fake clock, the live half off the
 * wall clock.
 */
export interface VoiceTurnObservation {
  /** The response was a 200 event stream ending in `[DONE]`, with no error frame and a known outcome. */
  protocol: { ok: true } | { ok: false; problem: string };
  outcome: VoiceOutcomeKind | null;
  pieces: Array<{ kind: VoicePieceKind; text: string; atMs: number }>;
  timings: {
    /** The first byte of the response body. */
    firstByteMs: number | null;
    /** The bridge line; null when none was spoken. */
    bridgeMs: number | null;
    /** The first piece that was not the bridge line: the reply's, a teammate's, or the fallback line. */
    firstSpeechMs: number | null;
    /** The response's end. */
    turnMs: number;
  };
  /** The turn's own record, the fields its log line carries, when the runner shares the serving process. */
  turnRecord?: Readonly<VoiceTurnSummary>;
}

/**
 * Voice assertions read a {@link VoiceTurnObservation}. All but `voice_turn_record` read the wire,
 * which both halves observe; the turn's record is read only where the runner shares the serving
 * process, which the deterministic half does.
 */
export type VoiceAssertion =
  /** The stream ended in `[DONE]` with no error frame and named a known outcome. */
  | { type: "voice_turn_well_formed" }
  /**
   * `latencyDependent`: on a real model, whether the bridge is spoken depends on how fast the model
   * answers (any planner slower than the stall bridge's 2.5 s hears one), so the live run, which
   * never gates on latency, leaves the assertion out.
   */
  | { type: "voice_bridge_spoken"; spoken: boolean; latencyDependent?: true }
  | { type: "voice_outcome"; kind: VoiceOutcomeKind }
  /** The kinds of the pieces heard, in order, with consecutive pieces of one kind counted once. */
  | { type: "voice_speech_order"; order: VoicePieceKind[] }
  /** How many pieces other than the bridge and fallback lines were heard. */
  | { type: "voice_speech_piece_count"; count: number }
  /** The first piece other than the bridge line, trimmed, is exactly this text. */
  | { type: "voice_first_speech"; text: string }
  /** Each named field of the turn's record has this value, or is absent from it. */
  | { type: "voice_turn_record"; fields: Partial<Record<keyof VoiceTurnSummary, VoiceTurnRecordExpectation>> };

const VOICE_ASSERTION_TYPES = new Set<string>([
  "voice_turn_well_formed",
  "voice_bridge_spoken",
  "voice_outcome",
  "voice_speech_order",
  "voice_speech_piece_count",
  "voice_first_speech",
  "voice_turn_record",
] satisfies Array<VoiceAssertion["type"]>);

export const isVoiceAssertion = (assertion: { type: string }): assertion is VoiceAssertion =>
  VOICE_ASSERTION_TYPES.has(assertion.type);

interface VoiceAssertionVerdict {
  assertion: VoiceAssertion;
  status: AssertionVerdictStatus;
  reason: string | null;
}

const verdict = (assertion: VoiceAssertion, held: boolean, reason: string): VoiceAssertionVerdict => ({
  assertion,
  status: held ? "pass" : "fail",
  reason,
});

/** Consecutive pieces of one kind collapse into one entry: an answer spoken in three sentences is one `speech`. */
const voicePieceOrder = (pieces: VoiceTurnObservation["pieces"]): VoicePieceKind[] =>
  pieces.reduce<VoicePieceKind[]>((order, piece) => (order.at(-1) === piece.kind ? order : [...order, piece.kind]), []);

const isAbsence = (expected: VoiceTurnRecordExpectation): expected is { absent: true } =>
  typeof expected === "object" && expected !== null;

const describeField = (record: Readonly<VoiceTurnSummary>, field: keyof VoiceTurnSummary): string =>
  field in record ? JSON.stringify(record[field]) : "absent";

const describeExpectation = (expected: VoiceTurnRecordExpectation): string =>
  isAbsence(expected) ? "absent" : JSON.stringify(expected);

const evaluateOnTurn = (assertion: VoiceAssertion, turn: VoiceTurnObservation): VoiceAssertionVerdict => {
  switch (assertion.type) {
    case "voice_turn_well_formed":
      return turn.protocol.ok
        ? verdict(assertion, true, "The stream ended in [DONE] and named its outcome.")
        : verdict(assertion, false, turn.protocol.problem);
    case "voice_bridge_spoken": {
      const bridged = turn.pieces.some((piece) => piece.kind === "bridge");
      return verdict(
        assertion,
        bridged === assertion.spoken,
        bridged ? `A bridge line was spoken at ${turn.timings.bridgeMs} ms.` : "No bridge line was spoken.",
      );
    }
    case "voice_outcome":
      return verdict(
        assertion,
        turn.outcome === assertion.kind,
        turn.outcome ? `The outcome was "${turn.outcome}".` : "The response named no outcome.",
      );
    case "voice_speech_order": {
      const order = voicePieceOrder(turn.pieces);
      const expected = assertion.order.join(" → ") || "nothing";
      const observed = order.join(" → ") || "nothing";
      return verdict(assertion, observed === expected, `Heard ${observed}; expected ${expected}.`);
    }
    case "voice_speech_piece_count": {
      const count = turn.pieces.filter((piece) => piece.kind === "speech").length;
      return verdict(assertion, count === assertion.count, `Heard ${count} speech piece(s); expected ${assertion.count}.`);
    }
    case "voice_first_speech": {
      const first = turn.pieces.find((piece) => piece.kind !== "bridge");
      const text = first?.text.trim();
      return verdict(
        assertion,
        text === assertion.text.trim(),
        first ? `The first speech was ${JSON.stringify(text)}.` : "Nothing but a bridge line was heard.",
      );
    }
    case "voice_turn_record": {
      const record = turn.turnRecord;
      if (!record) {
        return {
          assertion,
          status: "error",
          reason: "The turn's record is read only where the runner shares the serving process.",
        };
      }
      const mismatches = (Object.entries(assertion.fields) as Array<[keyof VoiceTurnSummary, VoiceTurnRecordExpectation]>)
        .filter(([field, expected]) => (isAbsence(expected) ? field in record : !(field in record) || record[field] !== expected));
      return mismatches.length === 0
        ? verdict(assertion, true, "The turn's record carried the expected fields.")
        : verdict(
          assertion,
          false,
          mismatches.map(([field, expected]) => `${field} was ${describeField(record, field)}; expected ${describeExpectation(expected)}`).join("; "),
        );
    }
  }
};

export const evaluateVoiceAssertion = (
  assertion: VoiceAssertion,
  output: ConversationQualityObservedOutput,
): VoiceAssertionVerdict =>
  output.voiceTurn
    ? evaluateOnTurn(assertion, output.voiceTurn)
    : { assertion, status: "error", reason: "Voice assertions read a voice turn; run the case as a voice case." };

/**
 * The voice assertions a live run gates on: what the wire shows of the behaviour. The wording, the
 * number of sentences and the turn's record are the model's or the serving process's, and a
 * timing the model sets is latency, which a live run reports and never gates on.
 */
const LIVE_VOICE_ASSERTIONS = new Set<string>(["voice_turn_well_formed", "voice_bridge_spoken", "voice_outcome"] satisfies Array<VoiceAssertion["type"]>);

const gatesLive = (assertion: { type: string }): boolean =>
  LIVE_VOICE_ASSERTIONS.has(assertion.type) && !(isVoiceAssertion(assertion) && assertion.type === "voice_bridge_spoken" && assertion.latencyDependent === true);

/**
 * The voice cases a live run drives, each scored on what it gates. A case whose scenario is a brain
 * slower than the turn policy's deadlines runs only in the deterministic half, which scripts one.
 */
export const scopeVoiceCasesForLiveRun = (cases: readonly ConversationQualityCase[]): ConversationQualityCase[] =>
  cases
    .filter((evalCase) => evalCase.voice !== undefined && evalCase.voice.requiresScriptedTiming !== true)
    .map((evalCase) => ({ ...evalCase, assertions: evalCase.assertions.filter(gatesLive) }));
