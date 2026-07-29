import type { GroundingDiagnosticSnapshot } from "../../shared/domain/groundingDiagnostic.js";
import { bindParam } from "./turnPopulationSql.js";

export interface GroundingDiagnosticRow {
  grounding_verdict: GroundingDiagnosticSnapshot["verdict"] | null;
  grounding_claim_count: number | null;
  grounding_sourced_claim_count: number | null;
  grounding_unsourced_claim_count: number | null;
  grounding_invalid_source_count: number | null;
}

export const mapGroundingDiagnostic = (
  row: GroundingDiagnosticRow,
): GroundingDiagnosticSnapshot | null => {
  const counts = [
    row.grounding_claim_count,
    row.grounding_sourced_claim_count,
    row.grounding_unsourced_claim_count,
    row.grounding_invalid_source_count,
  ];
  if (
    row.grounding_verdict === null
    || counts.some((value) => value === null || !Number.isSafeInteger(Number(value)) || Number(value) < 0)
    || Number(row.grounding_sourced_claim_count) + Number(row.grounding_unsourced_claim_count)
      !== Number(row.grounding_claim_count)
  ) {
    return null;
  }
  return {
    verdict: row.grounding_verdict,
    claimCount: Number(row.grounding_claim_count),
    sourcedClaimCount: Number(row.grounding_sourced_claim_count),
    unsourcedClaimCount: Number(row.grounding_unsourced_claim_count),
    invalidSourceCount: Number(row.grounding_invalid_source_count),
  };
};

export const buildGroundingVerdictPredicate = (
  verdicts: readonly GroundingDiagnosticSnapshot["verdict"][],
  params: unknown[],
): string => `m.grounding_verdict = ANY(${bindParam(params, [...new Set(verdicts)])}::text[])`;

export const buildGroundingCountPresencePredicate = (
  column: "grounding_unsourced_claim_count" | "grounding_invalid_source_count",
  present: boolean,
): string =>
  `m.grounding_verdict IS NOT NULL AND m.${column} ${present ? ">" : "="} 0`;
