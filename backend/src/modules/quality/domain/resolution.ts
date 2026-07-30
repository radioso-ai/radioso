import type {
  QualityResolution,
  QualityResolutionReason,
  QualityTriageState,
  ValidatedQualityTriageUpdate,
} from "../contracts/index.js";

export const QUALITY_RESOLVED_REASONS = [
  "knowledge_gap",
  "retrieval_issue",
  "agent_behavior",
  "platform_bug",
  "other",
] as const satisfies readonly QualityResolutionReason[];

export const QUALITY_DISMISSED_REASONS = [
  "expected_behavior",
  "out_of_scope",
  "invalid_feedback",
  "other",
] as const satisfies readonly QualityResolutionReason[];

export const QUALITY_RESOLUTION_REASONS = [
  "knowledge_gap",
  "retrieval_issue",
  "agent_behavior",
  "platform_bug",
  "expected_behavior",
  "out_of_scope",
  "invalid_feedback",
  "other",
] as const satisfies readonly QualityResolutionReason[];

export const QUALITY_RESOLUTION_NOTE_MAX_LENGTH = 500;

const terminalStates = new Set<QualityTriageState>(["resolved", "dismissed"]);
const resolvedReasons = new Set<string>(QUALITY_RESOLVED_REASONS);
const dismissedReasons = new Set<string>(QUALITY_DISMISSED_REASONS);

export class QualityResolutionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QualityResolutionValidationError";
  }
}

export interface QualityTriageUpdateCandidate {
  state: QualityTriageState;
  expectedVersion: number;
  resolution?: {
    reason: string;
    note?: string | null;
  } | null;
  legacyReason?: string | null;
}

const normalizeOptionalText = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
};

const normalizeResolution = (
  state: QualityTriageState,
  resolution: QualityTriageUpdateCandidate["resolution"],
): QualityResolution | null => {
  if (!resolution) {
    return null;
  }

  if (!terminalStates.has(state)) {
    throw new QualityResolutionValidationError("Active triage states cannot include resolution data");
  }

  const allowedReasons = state === "resolved" ? resolvedReasons : dismissedReasons;
  if (!allowedReasons.has(resolution.reason)) {
    throw new QualityResolutionValidationError(
      `Resolution reason is not valid for the ${state} state`,
    );
  }

  const note = normalizeOptionalText(resolution.note);
  if (note !== null && note.length > QUALITY_RESOLUTION_NOTE_MAX_LENGTH) {
    throw new QualityResolutionValidationError(
      `Resolution note must be at most ${QUALITY_RESOLUTION_NOTE_MAX_LENGTH} characters`,
    );
  }
  if (resolution.reason === "other" && note === null) {
    throw new QualityResolutionValidationError("The other resolution reason requires a note");
  }

  return {
    reason: resolution.reason as QualityResolutionReason,
    note,
  };
};

/**
 * Applies the state-dependent rules once, outside transport and persistence.
 * The deprecated legacy reason remains opaque text and is never mapped to a
 * structured reason.
 */
export const validateQualityTriageUpdate = (
  candidate: QualityTriageUpdateCandidate,
): ValidatedQualityTriageUpdate => {
  if (!Number.isInteger(candidate.expectedVersion) || candidate.expectedVersion < 0) {
    throw new QualityResolutionValidationError(
      "Expected triage version must be a non-negative integer",
    );
  }

  const resolution = normalizeResolution(candidate.state, candidate.resolution);
  const legacyReason = normalizeOptionalText(candidate.legacyReason);

  if (terminalStates.has(candidate.state) && resolution === null && legacyReason === null) {
    throw new QualityResolutionValidationError(
      "Terminal triage states require a structured resolution",
    );
  }

  return {
    state: candidate.state,
    expectedVersion: candidate.expectedVersion,
    resolution,
    legacyReason,
  };
};
