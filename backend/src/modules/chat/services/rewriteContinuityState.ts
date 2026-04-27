import { CHAT_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type { RetrievalExecutionDiagnostics, RewriteContinuityState } from "../../retrieval/domain/retrievalPipelineTypes.js";
import type { ChatCitation } from "./answerPresentationService.js";

const normalizeContinuityValue = (value?: string): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > CHAT_BEHAVIOR.carryForward.maxLiteralLength) {
    return undefined;
  }

  try {
    const url = new URL(normalized);
    if (url.protocol) {
      return undefined;
    }
  } catch {
    // Keep non-URL values.
  }

  return normalized;
};

const resolveContinuityActiveSubject = (candidate: string | undefined, groundedTitles: string[]): string | undefined => {
  const normalizedCandidate = normalizeContinuityValue(candidate);
  if (normalizedCandidate) {
    return normalizedCandidate;
  }

  return groundedTitles.length === 1 ? groundedTitles[0] : undefined;
};

const collectContinuityValues = (values: Array<string | undefined>): string[] => {
  const unique: string[] = [];
  for (const value of values) {
    const normalized = normalizeContinuityValue(value);
    if (!normalized || unique.includes(normalized)) {
      continue;
    }
    unique.push(normalized);
    if (unique.length >= CHAT_BEHAVIOR.carryForward.maxLiterals) {
      break;
    }
  }
  return unique;
};

export const buildRewriteContinuityState = (input: {
  previousState?: RewriteContinuityState;
  diagnostics: RetrievalExecutionDiagnostics;
  citations: ChatCitation[];
}): RewriteContinuityState | undefined => {
  const groundedTitles = collectContinuityValues([
    ...(input.previousState?.groundedTitles ?? []),
    ...input.citations.map((citation) => citation.title),
  ]);
  const activeSubject = resolveContinuityActiveSubject(
    normalizeContinuityValue(input.diagnostics.rewriteProposal?.proposedActiveSubject)
      ?? input.previousState?.activeSubject,
    groundedTitles,
  );
  const relatedEntities: string[] = [];

  if (!activeSubject && relatedEntities.length === 0 && groundedTitles.length === 0) {
    return undefined;
  }

  return {
    activeSubject,
    relatedEntities,
    groundedTitles,
  };
};

export const normalizeRewriteContinuityState = (state: unknown): RewriteContinuityState | undefined => {
  if (!state || typeof state !== "object") {
    return undefined;
  }

  const candidate = state as Partial<Record<keyof RewriteContinuityState, unknown>>;
  const groundedTitles = collectContinuityValues(
    Array.isArray(candidate.groundedTitles)
      ? candidate.groundedTitles.map((value) => (typeof value === "string" ? value : undefined))
      : [],
  );
  const activeSubject = resolveContinuityActiveSubject(
    typeof candidate.activeSubject === "string" ? candidate.activeSubject : undefined,
    groundedTitles,
  );
  const relatedEntities: string[] = [];

  if (!activeSubject && relatedEntities.length === 0 && groundedTitles.length === 0) {
    return undefined;
  }

  return {
    activeSubject,
    relatedEntities,
    groundedTitles,
  };
};
