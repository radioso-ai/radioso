import type { AppLogger } from "../../../shared/observability/logger.js";
import { setTraceAttributes } from "../../../shared/observability/tracing/operations.js";
import type {
  ResponseLanguageDetection,
  ResponseLanguageDetector,
  ResponseLanguageDetectorInput,
  ResponseLanguageUnresolvedReason,
} from "../../../shared/services/responseLanguageDetector.js";

/** Why a turn has no response language: the detector's own reasons, or a call that threw. */
type TurnResponseLanguageUnresolvedReason = ResponseLanguageUnresolvedReason | "detector_failed";

// Outcomes the detector's rules allow (nothing to judge, or no reliable language). The
// rest are failures of the call or of its output contract, and earn a warning.
const EXPECTED_UNRESOLVED_REASONS: ReadonlySet<TurnResponseLanguageUnresolvedReason> = new Set([
  "no_input",
  "no_label",
]);

interface TurnResponseLanguageInput {
  detector: ResponseLanguageDetector | undefined;
  request: ResponseLanguageDetectorInput;
  logContext: { workspaceId: string; conversationId: string };
  logger?: Pick<AppLogger, "warn">;
}

/**
 * Records the turn's response language on the active span: the label and where it came
 * from, or — when there is none — a stable reason. The fused planner and the staged
 * detector both record through here so the attribute set stays the same whichever
 * decided the turn.
 */
export const traceTurnResponseLanguage = (
  source: "planner" | "detector",
  language: string | undefined,
  unresolvedReason: TurnResponseLanguageUnresolvedReason = "no_label",
): void => {
  setTraceAttributes(language
    ? { "chat.response.language": language, "chat.response.language.source": source }
    : { "chat.response.language.source": source, "chat.response.language.unresolved_reason": unresolvedReason });
};

const recordUnresolved = (
  input: TurnResponseLanguageInput,
  reason: TurnResponseLanguageUnresolvedReason,
  errorType?: string,
): void => {
  traceTurnResponseLanguage("detector", undefined, reason);
  if (EXPECTED_UNRESOLVED_REASONS.has(reason)) {
    return;
  }
  input.logger?.warn(
    {
      workspaceId: input.logContext.workspaceId,
      conversationId: input.logContext.conversationId,
      reasonCode: "response_language_unresolved",
      unresolvedReason: reason,
      ...(errorType ? { errorType } : {}),
    },
    "Response language detection produced no label; routine replies, handoff endings, and answers fall back to the latest user message",
  );
};

/**
 * Runs the staged response-language detector for one chat turn — live chat, Test Chat,
 * eval replay, and approval resume all resolve through here whenever fused planning is
 * bypassed (for example, every turn of an active routine). A turn without a language
 * never fails: each generator falls back to the latest user message, and a routine
 * handoff ending renders from it directly. That fallback is recorded rather than
 * swallowed: the span carries the source and the unresolved reason, and a failed or
 * contract-breaking detection logs a warning. Structural fields only — the query, the
 * history, the model output, and the error message stay out of both.
 */
export const detectTurnResponseLanguage = async (
  input: TurnResponseLanguageInput,
): Promise<string | undefined> => {
  if (!input.detector) {
    return undefined;
  }
  let result: ResponseLanguageDetection;
  try {
    result = await input.detector.detect(input.request);
  } catch (error) {
    recordUnresolved(input, "detector_failed", error instanceof Error ? error.name : typeof error);
    return undefined;
  }
  if (result.responseLanguage) {
    traceTurnResponseLanguage("detector", result.responseLanguage);
    return result.responseLanguage;
  }
  recordUnresolved(input, result.unresolvedReason ?? "no_label");
  return undefined;
};
