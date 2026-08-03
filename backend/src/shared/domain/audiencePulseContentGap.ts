/**
 * Typed outcome rule shared by the Chat history adapter and Audience Pulse report
 * projection. It accepts no content and deliberately cannot infer corpus coverage.
 */
export const AUDIENCE_PULSE_GROUNDING_SIGNALS = [
  "grounded",
  "degraded",
  "no_support",
  "unknown",
] as const;

export type AudiencePulseGroundingSignal = (typeof AUDIENCE_PULSE_GROUNDING_SIGNALS)[number];

export const audiencePulseContentGapEligible = (input: {
  assistantAuthorship: "ai" | "human" | "unknown";
  skillName?: string | null;
  skillOutcome?: string | null;
  grounding: AudiencePulseGroundingSignal;
}): boolean => {
  if (input.assistantAuthorship !== "ai" || input.skillName !== "retrieval.answer") {
    return false;
  }

  return (input.skillOutcome === "no_context" && input.grounding === "no_support")
    || (input.skillOutcome === "grounded_degraded" && input.grounding === "degraded");
};
