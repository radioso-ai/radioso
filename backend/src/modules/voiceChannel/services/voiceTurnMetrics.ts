import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import type { VoiceBridgeStyle } from "../../agents/public.js";
import type { ChatTurnHandoffReason } from "../../chat/contracts/index.js";
import type { VoiceTurnOutcome } from "../domain.js";

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

/** Whether a superseded turn had spoken anything (its reply or the fallback line) when it was cut off. */
type VoiceSupersededStage = "before_speech" | "after_speech";

export const recordVoiceTurnSuperseded = (metrics: VoiceTurnMetricsSink | null | undefined, stage: VoiceSupersededStage): void => {
  metrics?.incrementCounter("voice_turn_superseded_total", {
    help: "Voice turns a newer request of the same session cut off; stage says whether the turn had spoken yet",
    labels: { stage },
  });
};

export const recordVoiceTurnReplayed = (metrics: VoiceTurnMetricsSink | null | undefined): void => {
  metrics?.incrementCounter("voice_turn_replayed_total", {
    help: "Identical voice re-requests answered with the stored reply of a turn that lost its caller, without a new turn",
  });
};

export const recordVoiceReplyInterrupted = (metrics: VoiceTurnMetricsSink | null | undefined): void => {
  metrics?.incrementCounter("voice_reply_interrupted_total", {
    help: "Stored voice replies the vendor reported cut short because the caller spoke over them",
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
