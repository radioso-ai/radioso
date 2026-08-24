import { CONTEXT_VARIABLES_BEHAVIOR } from "../../shared/domain/behaviorConfig.js";

import { PAGE_CONTEXT_VARIABLE_NAME } from "./contextResolutionService.js";
import {
  boundContextVariableFragments,
  type ContextVariableBoundClamp,
  type ContextVariableBoundDrop,
  type ContextVariableRenderBoundConfig,
  type ContextVariableRenderCandidate,
} from "./contextVariablesBound.js";
import type { ContextVariableSnapshot } from "./redaction.js";

export interface MatchContextProjection {
  /** Variable name to bounded value; empty when the turn resolved no usable context. */
  context: Record<string, unknown>;
  dropped: ContextVariableBoundDrop[];
  clamped: ContextVariableBoundClamp[];
}

/** Page fields that locate the visitor. The visible excerpt is deliberately not one of them. */
const PAGE_LOCATING_FIELDS = ["pageUrl", "pageTitle", "pageLocale", "browserLocale"] as const;

/**
 * Page context reaches matching as the fields that say *where the visitor is*.
 * The `content` excerpt is dropped rather than clamped: it is already rendered
 * into the answer prompt, and it would otherwise consume the whole match bound
 * on its own.
 */
const pageContextForMatching = (value: unknown): Record<string, string> | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const fragment = value as Record<string, unknown>;
  const projected: Record<string, string> = {};
  for (const field of PAGE_LOCATING_FIELDS) {
    const fieldValue = fragment[field];
    if (typeof fieldValue === "string" && fieldValue.length > 0) {
      projected[field] = fieldValue;
    }
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
};

/**
 * Projects the turn's resolved context variables into the bounded record handed
 * to directive matching, so an operator's prose condition can reference visitor
 * state ("the visitor's cart is worth more than EUR 100").
 *
 * The input is the *redacted* snapshot, which is the module's single redaction
 * boundary — sensitive values arrive already masked, so no sensitive value can
 * reach a matcher prompt through this path. Values keep their JSON type unless
 * the bound clamps them, in which case the clamped string (carrying the
 * truncation marker) is projected instead.
 */
export const projectContextForMatching = (
  snapshot: ContextVariableSnapshot,
  config: ContextVariableRenderBoundConfig = CONTEXT_VARIABLES_BEHAVIOR.matchBound,
): MatchContextProjection => {
  const values = new Map<string, unknown>();
  const candidates: ContextVariableRenderCandidate[] = [];

  for (const [name, snapshotValue] of Object.entries(snapshot)) {
    const value =
      name === PAGE_CONTEXT_VARIABLE_NAME ? pageContextForMatching(snapshotValue) : snapshotValue;
    const serialized = JSON.stringify(value);
    if (value === undefined || serialized === undefined) {
      continue;
    }
    values.set(name, value);
    candidates.push({ name, prefix: "", value: serialized });
  }

  const bound = boundContextVariableFragments(candidates, config);
  const clampedNames = new Set(bound.clamped.map((entry) => entry.variableName));

  return {
    context: Object.fromEntries(
      bound.kept.map((candidate) => [
        candidate.name,
        clampedNames.has(candidate.name) ? candidate.value : values.get(candidate.name),
      ]),
    ),
    dropped: bound.dropped,
    clamped: bound.clamped,
  };
};
