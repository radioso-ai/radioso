import type { GroundingDiagnosticSnapshot } from "../../../shared/domain/groundingDiagnostic.js";
import type { GroundingSummary } from "./groundingAssertions.js";

export const groundingDiagnosticFromSummary = (
  summary: GroundingSummary | undefined,
): GroundingDiagnosticSnapshot | undefined =>
  summary
    ? {
        verdict: summary.verdict,
        claimCount: summary.claimCount,
        sourcedClaimCount: summary.sourcedClaimCount,
        unsourcedClaimCount: summary.unsourcedClaimCount,
        invalidSourceCount: summary.invalidSourceCount,
      }
    : undefined;
