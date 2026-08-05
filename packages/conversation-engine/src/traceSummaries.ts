import type {
  AwaitingSkillInput,
  ConversationTurnInterpretation,
  DirectiveMatch,
  RenderableTurn,
  SkillDefinition,
  SkillTransientGuidance,
  SteeringRule,
  TurnOutcome,
} from "@radioso/conversation-contract";
import { createTrace, stage } from "./traceStages.js";

export const summarizeDirectiveMatch = (match: DirectiveMatch): Record<string, unknown> => ({
  // Directive copy is authored config (not user/assistant content), so keeping
  // it in the trace is safe and lets the UI render the matched rules in full.
  id: match.directive.id,
  name: match.directive.name,
  action: match.directive.action,
  description: match.directive.description,
  priority: match.directive.priority,
  condition: match.directive.condition.kind === "always"
    ? "always"
    : match.directive.condition.description,
  selectionMode: match.selectionMode,
  selectionReason: match.selectionReason,
  selectionConfidence: match.selectionConfidence,
});

/** Keep conversational text out of audit/debug traces; expose structural facts only. */
export const summarizeOutcomeForCompose = (outcome: TurnOutcome): Record<string, unknown> => ({
  skillName: outcome.skillName,
  status: outcome.outcome.status,
  errorCode: outcome.outcome.error?.code,
  errorMessage: outcome.outcome.error?.message,
  answerLength: outcome.outcome.answer?.length ?? 0,
});

export const composeOutputsFor = (
  response: RenderableTurn,
  outcomes: TurnOutcome[],
  options: { streamed: boolean },
): Record<string, unknown> => {
  const adherence = response.metadata?.directiveAdherence;
  return {
    answerLength: response.answer.length,
    citationCount: Array.isArray(response.citations) ? response.citations.length : 0,
    suggestionCount: Array.isArray(response.suggestions) ? response.suggestions.length : 0,
    outcomeCount: outcomes.length,
    streamed: options.streamed,
    outcomes: outcomes.map(summarizeOutcomeForCompose),
    ...(adherence ? { adherence } : {}),
  };
};

export const composeTraceMetricsFor = (response: RenderableTurn): Record<string, number> | undefined => {
  const candidate = response.metadata?.traceMetrics;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return undefined;
  }
  const metrics = Object.fromEntries(
    Object.entries(candidate).filter((entry): entry is [string, number] =>
      typeof entry[1] === "number" && Number.isFinite(entry[1])),
  );
  return Object.keys(metrics).length > 0 ? metrics : undefined;
};

export const summarizeFraming = (
  framing: ConversationTurnInterpretation["framing"],
): Record<string, unknown> | undefined => {
  if (!framing) {
    return undefined;
  }
  return {
    ...(typeof framing.isIdentityQuestion === "boolean"
      ? { isIdentityQuestion: framing.isIdentityQuestion }
      : {}),
    ...(typeof framing.intentTopic === "string" ? { hasIntentTopic: framing.intentTopic.length > 0 } : {}),
    ...(typeof framing.inScopeRequest === "string" ? { hasInScopeRequest: framing.inScopeRequest.length > 0 } : {}),
    ...(typeof framing.outsideScopeRequest === "string"
      ? { hasOutsideScopeRequest: framing.outsideScopeRequest.length > 0 }
      : {}),
  };
};

const summarizeRewriteProposal = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const proposal = value as Record<string, unknown>;
  return {
    ...(typeof proposal.queryShape === "string" ? { queryShape: proposal.queryShape } : {}),
    ...(typeof proposal.temporalQueryMode === "string" ? { temporalQueryMode: proposal.temporalQueryMode } : {}),
    ...(typeof proposal.turnKind === "string" ? { turnKind: proposal.turnKind } : {}),
    ...(typeof proposal.unresolved === "boolean" ? { unresolved: proposal.unresolved } : {}),
    ...(typeof proposal.confidence === "number" ? { confidence: proposal.confidence } : {}),
    ...(Array.isArray(proposal.retrievalSubqueries)
      ? { retrievalSubqueryCount: proposal.retrievalSubqueries.length }
      : {}),
  };
};

export const summarizeInterpretation = (
  interpretation: ConversationTurnInterpretation,
): Record<string, unknown> => ({
  route: interpretation.route,
  framing: summarizeFraming(interpretation.framing),
  metadata: interpretation.metadata
    ? (() => {
        const rewriteProposal = summarizeRewriteProposal(interpretation.metadata.rewriteProposal);
        return rewriteProposal ? { rewriteProposal } : {};
      })()
    : undefined,
});

export const guidanceToSteering = (
  guidance: SkillTransientGuidance,
  fallbackPriority?: number,
): SteeringRule => ({
  ...guidance,
  priority: guidance.priority ?? fallbackPriority,
  source: "skill",
  lifespan: "response",
});

export const composeAdherenceLinks = (response: RenderableTurn) =>
  response.metadata?.directiveAdherence
    ? [{ from: "directives", to: "compose", kind: "adherence" }]
    : undefined;

export const mergeStagedContext = (outcomes: TurnOutcome[]) =>
  outcomes.flatMap((outcome) => outcome.stagedContext);

export const findSkill = (skills: SkillDefinition[], name: string): SkillDefinition | null =>
  skills.find((skill) => skill.name === name) ?? null;

export const missingSkillOutcome = (skillName: string, steering: SteeringRule[]): TurnOutcome => ({
  kind: "generic",
  skillName,
  outcome: {
    status: "failed",
    error: {
      code: "skill_not_found",
      message: `Selected skill "${skillName}" is not registered.`,
      retryable: false,
    },
  },
  stagedContext: [],
  steering,
  trace: createTrace([
    stage({
      id: `dispatch:${skillName}`,
      kind: "skill_dispatch",
      status: "failed",
      outputs: { errorCode: "skill_not_found" },
    }),
  ]),
});

export const skillInputSteering = (awaiting: AwaitingSkillInput[]): SteeringRule => ({
  source: "skill",
  lifespan: "response",
  action: `Ask the user for all required skill inputs in one response: ${awaiting.map((entry) =>
    `${entry.skillName} (${entry.fields.map((field) =>
      `${field.name} (${field.type})${field.permittedValues ? `: ${field.permittedValues.join(", ")}` : ""}`).join(", ")})`).join("; ")}.`,
});
