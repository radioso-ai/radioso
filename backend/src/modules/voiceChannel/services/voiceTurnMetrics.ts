import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import type { VoiceBridgeStyle } from "../../agents/public.js";

export type VoiceTurnMetricsSink = Pick<MetricsRegistry, "observeHistogram" | "incrementCounter">;

const FIRST_SPEECH_BUCKETS_MS = [250, 500, 900, 1_200, 1_500, 2_000, 3_000, 5_000, 8_000, 12_000];

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
