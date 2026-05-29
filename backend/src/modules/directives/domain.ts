import type { SteeringCriticality, SteeringRule } from "../../shared/domain/steeringRule.js";

/**
 * A Directive is an authored, standing `condition → action` behavioral rule the
 * turn loop matches per turn and injects into answer composition to shape *how*
 * the agent behaves. It is the standing counterpart of a skill's transient
 * guidance; both unify on {@link SteeringRule}.
 *
 * Steer-Not-Act: a Directive carries condition/action + steering metadata only.
 * It has no execution descriptor, no executor, and no result channel — the
 * moment it gains a `dispatch()` it is a malformed Skill. Skills act; Directives
 * steer.
 */
export type DirectiveCondition =
  | { kind: "always" }
  | { kind: "contextual"; description: string };

export interface Directive {
  name: string;
  condition: DirectiveCondition;
  /** Instruction to the composer, LLM-consumed — never literal user-facing copy. */
  action: string;
  priority?: number;
  criticality?: SteeringCriticality;
  /** The directive is only injected if the agent holds these capabilities. */
  requiredCapabilities?: string[];
  description?: string;
}

export type DirectiveSelectionMode = "deterministic" | "probabilistic";

export interface DirectiveMatch {
  directive: Directive;
  selectionMode: DirectiveSelectionMode;
  selectionReason: string;
  selectionConfidence?: number;
}

export interface DirectiveOmission {
  directiveName: string;
  reason: string;
}

/** Maps a matched Directive into a directive-sourced, response-lifespan SteeringRule. */
export const directiveToSteeringRule = (match: DirectiveMatch): SteeringRule => ({
  action: match.directive.action,
  condition: match.directive.condition.kind === "contextual"
    ? match.directive.condition.description
    : undefined,
  priority: match.directive.priority,
  criticality: match.directive.criticality,
  description: match.directive.description,
  source: "directive",
  lifespan: "response",
});
