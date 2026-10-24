import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import type { VoiceBridgeStyle } from "../../agents/public.js";
import type { ChatTurnHandoffReason } from "../../chat/contracts/index.js";
import type { VoiceLanguageSwitchOutcome, VoiceTurnLanguageSource, VoiceTurnOutcome } from "../domain.js";

/** A switch's fate, as the instance holding the turn that asked for it sees it. */
type VoiceLanguageSwitchFate = Extract<VoiceLanguageSwitchOutcome, "emitted" | "unanswered" | "mismatched">;

/** How the runtime's follow-up after a switch was handled, as the instance it reached sees it. */
type VoiceLanguageSwitchFollowUp = Extract<VoiceLanguageSwitchOutcome, "confirmed" | "refused" | "unheld">;

export type VoiceTurnMetricsSink = Pick<MetricsRegistry, "observeHistogram" | "incrementCounter">;

const FIRST_SPEECH_BUCKETS_MS = [250, 500, 900, 1_200, 1_500, 2_000, 3_000, 5_000, 8_000, 10_000, 12_000];

const yesNo = (value: boolean): string => (value ? "yes" : "no");

/**
 * Turn-policy series for voice. Labels are closed enums only: no conversation, agent, locale tag,
 * or line text ever becomes a label.
 */
export const recordVoiceFirstSpeech = (metrics: VoiceTurnMetricsSink | null | undefined, elapsedMs: number, bridged: boolean): void => {
  metrics?.observeHistogram("voice_turn_first_speech_ms", {
    help: "Time from the start of a voice turn to its first speech, the reply's or the fallback line's",
    labels: { bridged: yesNo(bridged) },
    value: elapsedMs,
    buckets: FIRST_SPEECH_BUCKETS_MS,
  });
};

export const recordVoiceBridgeDue = (
  metrics: VoiceTurnMetricsSink | null | undefined,
  style: VoiceBridgeStyle,
  spoken: boolean,
): void => {
  metrics?.incrementCounter("voice_bridge_emitted_total", {
    help: "Voice turns that reached the bridge delay without speech; locale_resolved=no means the agent had no line to speak",
    labels: { style, locale_resolved: yesNo(spoken) },
  });
};

export const recordVoiceTurnLimit = (metrics: VoiceTurnMetricsSink | null | undefined, spoken: boolean): void => {
  metrics?.incrementCounter("voice_turn_limit_total", {
    help: "Voice turns that reached the turn limit without speech; locale_resolved=no means no fallback line, so the turn kept waiting",
    labels: { locale_resolved: yesNo(spoken) },
  });
};

/** Where the language a policy turn's lines were picked in came from. The tag itself is never a label. */
export const recordVoiceTurnLanguage = (metrics: VoiceTurnMetricsSink | null | undefined, source: VoiceTurnLanguageSource): void => {
  metrics?.incrementCounter("voice_turn_language_source_total", {
    help: "Voice turns by where the language of their bridge and fallback lines came from; vendor_detected and turn_field are reports for the turn itself",
    labels: { source },
  });
};

/**
 * Switches of the call's language: each one a turn asks for (`emitted`), and each one let go with
 * no follow-up speaking it (`unanswered`, `mismatched`), by the instance holding the turn. The
 * language is never a label.
 */
export const recordVoiceLanguageSwitch = (metrics: VoiceTurnMetricsSink | null | undefined, outcome: VoiceLanguageSwitchFate): void => {
  metrics?.incrementCounter("voice_language_switch_total", {
    help: "Switches of a call's language voice turns asked the runtime for (emitted), and those let go unspoken: no follow-up came or one was overtaken (unanswered), or the session's follow-up was for another utterance (mismatched)",
    labels: { outcome },
  });
};

/**
 * The runtime's follow-ups after a switch, by the instance each reached: it spoke the held turn's
 * answer after the runtime carried the switch out (`confirmed`) or refused it (`refused`), or it
 * held no turn for the follow-up (`unheld`).
 */
export const recordVoiceLanguageSwitchFollowUp = (metrics: VoiceTurnMetricsSink | null | undefined, outcome: VoiceLanguageSwitchFollowUp): void => {
  metrics?.incrementCounter("voice_language_switch_followup_total", {
    help: "Follow-ups of a voice turn's switch of the call's language: speaking the held answer once the runtime switched (confirmed) or refused (refused), or holding no switched turn for it (unheld)",
    labels: { outcome },
  });
};

/** Whether a superseded turn had spoken anything (its reply or the fallback line) when it was cut off. */
type VoiceSupersededStage = "before_speech" | "after_speech";

export const recordVoiceTurnSuperseded = (metrics: VoiceTurnMetricsSink | null | undefined, stage: VoiceSupersededStage): void => {
  metrics?.incrementCounter("voice_turn_superseded_total", {
    help: "Voice turns a newer request of the same session cut off; stage says whether the turn had spoken yet",
    labels: { stage },
  });
};

/** The runtime tore the turn's request down before the turn reached its outcome. */
export const recordVoiceTurnAbandoned = (metrics: VoiceTurnMetricsSink | null | undefined): void => {
  metrics?.incrementCounter("voice_turn_abandoned_total", {
    help: "Voice turns whose request the voice runtime tore down before the turn reached its outcome",
  });
};

export const recordVoiceTurnReplayed = (metrics: VoiceTurnMetricsSink | null | undefined): void => {
  metrics?.incrementCounter("voice_turn_replayed_total", {
    help: "Identical voice re-requests answered with the stored reply of a turn that lost its caller, without a new turn",
  });
};

/** `partial`: the caller cut the reply off while it streamed, so only its heard part is stored. */
export const recordVoiceReplyInterrupted = (metrics: VoiceTurnMetricsSink | null | undefined, partial: boolean): void => {
  metrics?.incrementCounter("voice_reply_interrupted_total", {
    help: "Stored voice replies the caller spoke over; partial=yes when the reply was cut off mid-stream and only its heard part is stored",
    labels: { partial: yesNo(partial) },
  });
};

export const recordVoiceOperatorRepliesSpoken = (metrics: VoiceTurnMetricsSink | null | undefined, replyCount: number): void => {
  metrics?.incrementCounter("voice_operator_reply_spoken_total", {
    help: "Teammate replies from the Inbox that a voice turn handed to the caller",
    value: replyCount,
  });
};

export const recordVoiceTurnOutcome = (
  metrics: VoiceTurnMetricsSink | null | undefined,
  kind: VoiceTurnOutcome["kind"],
  handoffReason: ChatTurnHandoffReason | null,
): void => {
  metrics?.incrementCounter("voice_turn_outcome_total", {
    help: "Voice turns by the outcome the runtime received; handoff_reason says why the turn handed the conversation to a person, none when it did not",
    labels: { kind, handoff_reason: handoffReason ?? "none" },
  });
};
