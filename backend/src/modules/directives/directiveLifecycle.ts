import type { GenerationSurface } from "../../shared/domain/generationSurface.js";
import { addressesSurface, type SteeringRule } from "../../shared/domain/steeringRule.js";
import type { Directive, DirectiveLifecycle } from "./domain.js";

/**
 * Cross-turn directive firing memory. This is the structural fix for the
 * repetition bug class (self-reintroduction, one-time guidance re-firing every
 * turn): matching stays stateless per turn, and the host remembers — per
 * conversation — which directives have already fired so `once_per_conversation`
 * and `cooldown` directives can be suppressed before matching runs.
 *
 * A directive counts as "fired" on a turn only when it renders into the steering
 * block (matched *and* not held back by the steering bound) — a directive the
 * bound dropped never reached the model, so it did not fire.
 */

/** One directive's firing record within a conversation. */
export interface DirectiveFiring {
  /** The `turnSeq` at which the directive last rendered into steering. */
  lastFiredTurn: number;
  /** How many turns the directive has fired on in this conversation. */
  count: number;
}

/** Per-conversation directive firing state, persisted keyed by conversation id. */
export interface DirectiveFiringState {
  /**
   * The index of the *next* turn to be committed (equivalently, the count of
   * turns already committed for this conversation). Stable within a turn — it
   * advances exactly once, at turn completion — so the matcher closure may run
   * more than once per turn (routine attempt + process turn) without drift.
   */
  turnSeq: number;
  firings: Record<string, DirectiveFiring>;
}

export const emptyDirectiveFiringState = (): DirectiveFiringState => ({ turnSeq: 0, firings: {} });

const repeatable: DirectiveLifecycle = { kind: "repeatable" };

/**
 * Narrow a persisted/authored lifecycle payload to a known kind. Returns
 * `undefined` for absent or malformed values so callers can treat "no lifecycle"
 * as the repeatable default and never persist a broken record.
 */
export const parseDirectiveLifecycle = (value: unknown): DirectiveLifecycle | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "repeatable" || kind === "once_per_conversation") {
    return { kind };
  }
  if (kind === "cooldown") {
    const turns = (value as { turns?: unknown }).turns;
    if (typeof turns === "number" && Number.isInteger(turns) && turns > 0) {
      return { kind, turns };
    }
  }
  return undefined;
};

const lifecycleOf = (directive: Directive): DirectiveLifecycle => directive.lifecycle ?? repeatable;

/**
 * Whether a directive may fire this turn given its lifecycle and the
 * conversation's firing memory. Repeatable directives (the default) are always
 * eligible; `once_per_conversation` is eligible only until its first firing; a
 * `cooldown` directive is eligible again strictly after `turns` turns have
 * passed since it last fired (so `turns: 2` skips the two turns after a firing).
 */
export const isDirectiveLifecycleEligible = (
  directive: Directive,
  state: DirectiveFiringState,
): boolean => {
  const lifecycle = lifecycleOf(directive);
  if (lifecycle.kind === "repeatable") {
    return true;
  }
  const firing = state.firings[directive.name];
  if (!firing) {
    return true;
  }
  if (lifecycle.kind === "once_per_conversation") {
    return false;
  }
  return state.turnSeq - firing.lastFiredTurn > lifecycle.turns;
};

/** True when a directive carries lifecycle worth remembering across turns. */
export const directiveHasTrackedLifecycle = (directive: Directive): boolean =>
  lifecycleOf(directive).kind !== "repeatable";

/** A directive held back this turn by its lifecycle policy, for the turn trace. */
export interface DirectiveLifecycleSuppression {
  directiveName: string;
  lifecycle: DirectiveLifecycle;
}

/**
 * The tracked-lifecycle directives among `directives` that their firing memory
 * suppresses this turn — the trace's record of why a directive that would
 * otherwise match did not steer.
 */
export const lifecycleSuppressedDirectives = (
  directives: readonly Directive[],
  state: DirectiveFiringState,
): DirectiveLifecycleSuppression[] =>
  directives
    .filter(directiveHasTrackedLifecycle)
    .filter((directive) => !isDirectiveLifecycleEligible(directive, state))
    .map((directive) => ({ directiveName: directive.name, lifecycle: lifecycleOf(directive) }));

/**
 * The lifecycle-eligibility split for a turn's scope-eligible directive set,
 * given the conversation's firing memory. Owns the partition the chat host
 * previously composed inline from the primitives above: which directives may
 * match this turn, which tracked names to capture if they render, and which the
 * lifecycle policy suppressed (for the trace).
 */
export interface DirectiveLifecyclePartition {
  /** Directives that may be matched this turn (lifecycle-eligible). */
  eligible: Directive[];
  /**
   * Tracked-lifecycle directive names among the eligible set — the names whose
   * firing must be captured when they render into steering.
   */
  trackedNames: Set<string>;
  /** Tracked directives the firing memory suppresses this turn, for the trace. */
  suppressed: DirectiveLifecycleSuppression[];
}

/**
 * Partition a turn's scope-eligible directives by their cross-turn lifecycle
 * policy. With no firing memory every directive stays eligible and nothing is
 * tracked or suppressed (behavior-preserving for hosts without a durable store).
 */
export const partitionDirectivesByLifecycle = (
  scopeEligible: readonly Directive[],
  firingState: DirectiveFiringState | undefined,
): DirectiveLifecyclePartition => {
  if (!firingState) {
    return { eligible: [...scopeEligible], trackedNames: new Set(), suppressed: [] };
  }
  const eligible = scopeEligible.filter((directive) => isDirectiveLifecycleEligible(directive, firingState));
  const trackedNames = new Set(eligible.filter(directiveHasTrackedLifecycle).map((directive) => directive.name));
  const suppressed = lifecycleSuppressedDirectives(scopeEligible, firingState);
  return { eligible, trackedNames, suppressed };
};

/**
 * Authored directives that actually rendered, read from the post-resolution rules.
 * Those rules preserve the exact surfaces that survived independent relationship
 * and prompt-bound passes; the pre-bound matches cannot answer that question.
 */
export const renderedDirectiveNames = (
  result: {
    rules: SteeringRule[];
  },
  /**
   * Narrows to the directives addressed to one generator. A turn renders each
   * generator's block at a different moment — the answer always, the follow-up
   * questions only when they are generated — so "fired" is asked per surface and
   * captured when that block actually renders. Omit to ask about every surface.
   */
  surface?: GenerationSurface,
): string[] => {
  const rendered = result.rules.flatMap((rule) =>
    rule.directiveName !== undefined
      && (surface === undefined || addressesSurface(rule.surfaces, surface))
      ? [rule.directiveName]
      : [],
  );
  return [...new Set(rendered)];
};

/**
 * Fold the set of directives that fired on the current turn into the firing
 * state and advance the turn sequence. Pure — returns a new state and never
 * mutates the input, so the deferred store can capture across matcher calls and
 * commit once at turn completion.
 */
export const commitDirectiveFirings = (
  state: DirectiveFiringState,
  firedNames: readonly string[],
): DirectiveFiringState => {
  const firings: Record<string, DirectiveFiring> = { ...state.firings };
  for (const name of firedNames) {
    const prior = firings[name];
    firings[name] = { lastFiredTurn: state.turnSeq, count: (prior?.count ?? 0) + 1 };
  }
  return { turnSeq: state.turnSeq + 1, firings };
};
