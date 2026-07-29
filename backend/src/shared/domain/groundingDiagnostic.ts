export const GROUNDING_VERDICTS = ["grounded", "degraded", "no_support"] as const;

export type GroundingVerdict = (typeof GROUNDING_VERDICTS)[number];

/** Immutable, complete per-answer snapshot shared at persistence/read boundaries. */
export interface GroundingDiagnosticSnapshot {
  verdict: GroundingVerdict;
  claimCount: number;
  sourcedClaimCount: number;
  unsourcedClaimCount: number;
  invalidSourceCount: number;
}
