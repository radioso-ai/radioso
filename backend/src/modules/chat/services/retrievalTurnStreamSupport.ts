export class GroundingStreamGateBoundError extends Error {
  constructor() {
    super("grounding_stream_gate_bound");
    this.name = "GroundingStreamGateBoundError";
  }
}

/** Abort reason for the model stream when a coverage verdict sink yields the turn (#1260, FR-006). */
export class CoverageVerdictYieldedError extends Error {
  constructor() {
    super("coverage_verdict_yielded");
    this.name = "CoverageVerdictYieldedError";
  }
}

/** The compose-stage trace metrics that were measured; none when nothing was. */
export const measuredTraceMetrics = (metrics: Record<string, number | undefined>): { traceMetrics?: Record<string, number> } => {
  const measured = Object.fromEntries(
    Object.entries(metrics).filter((entry): entry is [string, number] => entry[1] !== undefined),
  );
  return Object.keys(measured).length > 0 ? { traceMetrics: measured } : {};
};

/** How many links the answer carried to addresses its model was not given; none when it carried none. */
export const unwrappedLinkCount = (unwrapped: readonly unknown[]): number | undefined => unwrapped.length || undefined;

export const combineAbortSignals = (turnSignal: AbortSignal | undefined, gateSignal: AbortSignal): AbortSignal =>
  turnSignal ? AbortSignal.any([turnSignal, gateSignal]) : gateSignal;
