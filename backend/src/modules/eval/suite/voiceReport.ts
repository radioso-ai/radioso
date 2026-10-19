import { buildBaselineFile, mergeBaselineFile, type BaselineFile, type CaseOutcome } from "./baseline.js";
import type { VoiceTurnObservation } from "./voiceAssertions.js";

/** One sample of a voice case: the scored turn as observed, or the error that stopped the runner observing it. */
export type VoiceCaseSample = VoiceTurnObservation | { error: string };

/**
 * One voice case's numbers across its samples; each time is the median of the samples that had it.
 * Every count is out of all the samples, those that errored included.
 */
interface VoiceCaseLatency {
  caseId: string;
  samples: number;
  /** Samples in which a bridge line was spoken. */
  bridged: number;
  /** Samples per outcome kind the response named; `none` for a response that named none. */
  outcomes: Record<string, number>;
  /** Samples whose stream was not well formed. */
  protocolErrors: number;
  /** Samples the runner could not observe at all. */
  errored: number;
  firstByteMs: number | null;
  bridgeMs: number | null;
  firstSpeechMs: number | null;
  turnMs: number | null;
  /** Every sample's time to first speech, for the percentiles across cases. */
  firstSpeechSamplesMs: number[];
  turnSamplesMs: number[];
}

/**
 * What a recorded voice baseline keeps of each case's latency: the medians the recording run
 * measured. Null until a recording run measures them. Reported against, never gated on.
 */
export interface VoiceLatencyBaselineEntry {
  firstByteMs: number | null;
  firstSpeechMs: number | null;
  turnMs: number | null;
}

/** The voice cases' baseline: statuses gate like the text suite's; latency is only reported against. */
export interface VoiceBaselineFile extends BaselineFile {
  latency: Record<string, VoiceLatencyBaselineEntry>;
}

/** A case's time to first speech is called slow, in the report only, past this multiple of its baseline median. */
const LATENCY_WARNING_FACTOR = 2;

/** Nearest-rank percentile; null for no values. */
const percentile = (values: readonly number[], fraction: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(fraction * sorted.length)));
  return sorted[rank - 1] ?? null;
};

const present = (values: ReadonlyArray<number | null>): number[] => values.filter((value): value is number => value !== null);

const isObservation = (sample: VoiceCaseSample): sample is VoiceTurnObservation => !("error" in sample);

export const summarizeVoiceCase = (caseId: string, samples: readonly VoiceCaseSample[]): VoiceCaseLatency => {
  const observations = samples.filter(isObservation);
  const outcomes: Record<string, number> = {};
  for (const observation of observations) {
    const kind = observation.outcome ?? "none";
    outcomes[kind] = (outcomes[kind] ?? 0) + 1;
  }
  const firstSpeechSamplesMs = present(observations.map((observation) => observation.timings.firstSpeechMs));
  const turnSamplesMs = observations.map((observation) => observation.timings.turnMs);
  return {
    caseId,
    samples: samples.length,
    bridged: observations.filter((observation) => observation.timings.bridgeMs !== null).length,
    outcomes,
    protocolErrors: observations.filter((observation) => !observation.protocol.ok).length,
    errored: samples.length - observations.length,
    firstByteMs: percentile(present(observations.map((observation) => observation.timings.firstByteMs)), 0.5),
    bridgeMs: percentile(present(observations.map((observation) => observation.timings.bridgeMs)), 0.5),
    firstSpeechMs: percentile(firstSpeechSamplesMs, 0.5),
    turnMs: percentile(turnSamplesMs, 0.5),
    firstSpeechSamplesMs,
    turnSamplesMs,
  };
};

/** A baseline entry no recording run has measured yet. */
const isUnrecorded = (entry: VoiceLatencyBaselineEntry | undefined): boolean =>
  entry === undefined || (entry.firstByteMs === null && entry.firstSpeechMs === null && entry.turnMs === null);

/**
 * The line a report carries while cases have no latency baseline. The baseline is recorded where
 * the nightly runs, since a laptop's latency is not the nightly's.
 */
export const unrecordedLatencyNotice = (
  latencies: ReadonlyArray<Pick<VoiceCaseLatency, "caseId">>,
  baseline: Readonly<Record<string, VoiceLatencyBaselineEntry>>,
): string | null => {
  const unrecorded = latencies.filter((latency) => isUnrecorded(baseline[latency.caseId])).length;
  return unrecorded === 0
    ? null
    : `No latency baseline for ${unrecorded} case(s): run \`evals:voice:update-baseline\` in CI (dispatch Conversation Quality Evals with record_voice_baseline) and commit the voice-baseline.json artifact it uploads.`;
};

const ms = (value: number | null): string => (value === null ? "-" : `${Math.round(value)} ms`);

const describeOutcomes = (latency: VoiceCaseLatency): string =>
  Object.entries(latency.outcomes).map(([kind, count]) => `${kind} ${count}/${latency.samples}`).join(", ") || "none";

/**
 * The voice section of the report: per case, how often it bridged, the outcomes it named, and
 * its median times; then the time to first speech and the turn time across every sample of every
 * case; then, without failing anything, each case whose median time to first speech is more
 * than twice its baseline median.
 */
export const formatVoiceLatencyReport = (
  latencies: readonly VoiceCaseLatency[],
  baseline: Readonly<Record<string, VoiceLatencyBaselineEntry>>,
): string => {
  const lines: string[] = ["Voice turns (medians across samples; latency is reported, never gated):"];
  for (const latency of latencies) {
    lines.push(
      `  ${latency.caseId}: bridged ${latency.bridged}/${latency.samples}, outcome ${describeOutcomes(latency)}`
      + `${latency.protocolErrors > 0 ? `, ${latency.protocolErrors} malformed` : ""}`
      + `${latency.errored > 0 ? `, ${latency.errored} errored` : ""}`
      + ` | first byte ${ms(latency.firstByteMs)}, bridge ${ms(latency.bridgeMs)}, first speech ${ms(latency.firstSpeechMs)}, turn ${ms(latency.turnMs)}`,
    );
  }
  const firstSpeech = latencies.flatMap((latency) => latency.firstSpeechSamplesMs);
  const turn = latencies.flatMap((latency) => latency.turnSamplesMs);
  lines.push(
    `  Across cases: first speech p50 ${ms(percentile(firstSpeech, 0.5))}, p95 ${ms(percentile(firstSpeech, 0.95))}; `
    + `turn p50 ${ms(percentile(turn, 0.5))}, p95 ${ms(percentile(turn, 0.95))}`,
  );
  const notice = unrecordedLatencyNotice(latencies, baseline);
  if (notice) {
    lines.push(`  ${notice}`);
  }
  const slow = latencies.filter((latency) => {
    const recorded = baseline[latency.caseId]?.firstSpeechMs ?? null;
    return recorded !== null && latency.firstSpeechMs !== null && latency.firstSpeechMs > recorded * LATENCY_WARNING_FACTOR;
  });
  if (slow.length > 0) {
    lines.push(`  Slower than ${LATENCY_WARNING_FACTOR}x the baseline median (a warning; it does not fail the run):`);
    for (const latency of slow) {
      lines.push(`    ! ${latency.caseId}: first speech ${ms(latency.firstSpeechMs)}, baseline ${ms(baseline[latency.caseId]?.firstSpeechMs ?? null)}`);
    }
  }
  return lines.join("\n");
};

/**
 * The voice baseline a recording run writes: statuses as the text suite records them, and each
 * observed case's medians. A filtered recording replaces only the cases it ran, so the rest of
 * the baseline survives, as `mergeBaselineFile` does for statuses.
 */
export const recordVoiceBaseline = (input: {
  previous: VoiceBaselineFile;
  outcomes: CaseOutcome[];
  latencies: readonly VoiceCaseLatency[];
  generatedAt: string;
  passThreshold: number;
  filtered: boolean;
}): VoiceBaselineFile => {
  const statuses = input.filtered
    ? mergeBaselineFile(input.previous, input.outcomes, input.generatedAt, input.passThreshold)
    : buildBaselineFile(input.outcomes, input.generatedAt, input.passThreshold);
  const measured = Object.fromEntries(input.latencies.map((latency): [string, VoiceLatencyBaselineEntry] => [
    latency.caseId,
    { firstByteMs: latency.firstByteMs, firstSpeechMs: latency.firstSpeechMs, turnMs: latency.turnMs },
  ]));
  const latency = { ...(input.filtered ? input.previous.latency : {}), ...measured };
  return {
    ...statuses,
    latency: Object.fromEntries(Object.keys(latency).sort().map((caseId) => [caseId, latency[caseId]])),
  };
};
