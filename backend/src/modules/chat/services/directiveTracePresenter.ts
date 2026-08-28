import { effectiveSurfaces, resolveRenderSurfaces } from "../../../shared/domain/steeringRule.js";
import type { ActivityTrace } from "../../retrieval/public.js";
import type { DirectiveSteeringResult } from "../../directives/public.js";

/**
 * Appends a directive-steering stage to a turn's activity trace, at parity with
 * how skill selection is traced. Chat-owned: it consumes the public ActivityTrace
 * contract and never reaches into retrieval internals.
 *
 * Behavior-preserving when nothing was matched or omitted — an empty standing
 * directive set leaves the trace untouched.
 */
export const appendDirectiveSteeringStage = (
  trace: ActivityTrace,
  steering: DirectiveSteeringResult | undefined,
): ActivityTrace => {
  const bounded = steering?.bounded ?? [];
  const lifecycleSuppressed = steering?.lifecycleSuppressed ?? [];
  if (
    !steering ||
    (steering.matches.length === 0 &&
      steering.omissions.length === 0 &&
      bounded.length === 0 &&
      lifecycleSuppressed.length === 0)
  ) {
    return trace;
  }

  const stageId = "directive_steering";
  const previousStageId = trace.stages.at(-1)?.stageId;

  return {
    ...trace,
    stages: [
      ...trace.stages,
      {
        stageId,
        kind: "directive_steering",
        label: "Directive steering",
        status: "applied",
        startedAt: new Date().toISOString(),
        outputs: {
          matched: steering.matches.map((match) => ({
            name: match.directive.name,
            selectionMode: match.selectionMode,
            selectionReason: match.selectionReason,
            selectionConfidence: match.selectionConfidence,
            // Which generator the rule reached. Resolved rather than authored: a
            // directive narrowed by a relationship on one generator shows only the
            // ones it survived on, so a builder can tell "applied to the reply" from
            // "applied to the follow-up questions".
            surfaces: [...effectiveSurfaces(resolveRenderSurfaces(match))],
          })),
          omitted: steering.omissions,
          // Matched but held back from the rendered steering block by the top-k
          // cap or token budget — surfaced so builders see why a directive that
          // matched still did not steer this turn.
          bounded,
          // Held back before matching by a once/cooldown lifecycle policy that
          // already fired earlier in the conversation (#865).
          lifecycleSuppressed,
          // Which generators produced output this turn. Compare against each match's
          // `surfaces` to tell a rule that reached the visitor from one whose target
          // generator never ran. Covers every matched rule, unlike `pendingSurfaces`.
          renderedSurfaces: steering.renderedSurfaces,
          // Lifecycle only: once/cooldown directives whose budget is still unspent
          // because the generator they address had not rendered when this closed.
          pendingSurfaces: steering.pendingSurfaceFirings,
        },
      },
    ],
    links: previousStageId
      ? [...trace.links, { fromStageId: previousStageId, toStageId: stageId, kind: "sequence" as const }]
      : trace.links,
  };
};
