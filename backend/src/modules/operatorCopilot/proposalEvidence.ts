import type {
  CopilotProposalEvidence,
  CopilotProposalEvidenceCase,
  CopilotProposalEvidenceSummary,
} from "./contracts.js";

export type {
  CopilotProposalEvidence,
  CopilotProposalEvidenceCase,
  CopilotProposalEvidenceSummary,
} from "./contracts.js";

const FAILED_BEFORE = new Set<CopilotProposalEvidenceCase["before"]>(["failing", "error"]);
const FAILED_AFTER = new Set<CopilotProposalEvidenceCase["after"]>(["fail", "error"]);

/**
 * Reduces measured cases to what a card can state. A case only counts as improved when it was
 * recorded as broken and the replay passed, and only as regressed when it was recorded as passing
 * and the replay did not. Everything else — including a replay of a case with no assertions, which
 * scores nothing — is unchanged, because reading it as a fix would overstate the evidence.
 */
export const summarizeProposalEvidence = (
  evidence: CopilotProposalEvidence,
): CopilotProposalEvidenceSummary => {
  let improved = 0;
  let regressed = 0;
  let stale = 0;
  for (const measurement of evidence.cases) {
    if (measurement.stale) stale += 1;
    if (FAILED_BEFORE.has(measurement.before) && measurement.after === "pass") improved += 1;
    else if (measurement.before === "passing" && FAILED_AFTER.has(measurement.after)) regressed += 1;
  }
  return {
    total: evidence.cases.length,
    improved,
    regressed,
    unchanged: evidence.cases.length - improved - regressed,
    stale,
  };
};
