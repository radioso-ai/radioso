/** Bounds for the host-defined variables rendered into an answer prompt. */
export interface ContextVariableRenderBoundConfig {
  maxRenderedVariables: number;
  perValueMaxChars: number;
  sectionTokenBudget: number;
}

export interface ContextVariableRenderCandidate {
  name: string;
  /** Everything in the rendered line before the JSON value. */
  prefix: string;
  /** The JSON-stringified value. */
  value: string;
}

export type ContextVariableBoundDropReason = "count_cap" | "token_budget";

export interface ContextVariableBoundDrop {
  variableName: string;
  reason: ContextVariableBoundDropReason;
}

export interface ContextVariableBoundClamp {
  variableName: string;
  originalChars: number;
  retainedChars: number;
}

export interface ContextVariableBoundResult {
  kept: ContextVariableRenderCandidate[];
  dropped: ContextVariableBoundDrop[];
  clamped: ContextVariableBoundClamp[];
}

const TRUNCATION_MARKER = "… [truncated]";

const clampValue = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - TRUNCATION_MARKER.length))}${TRUNCATION_MARKER}`;
};

// This mirrors directive steering's deliberately approximate, repo-standard
// character estimate. The bound is a prompt-size guard, not token accounting.
const estimateTokens = (fragment: ContextVariableRenderCandidate): number =>
  Math.max(1, Math.ceil((fragment.prefix.length + fragment.value.length) / 4));

/**
 * Bounds renderable host variables without changing their order. Values are
 * clamped before count and section-budget decisions, so the result is safe to
 * render directly and carries content-free observability details for the caller.
 */
export const boundContextVariableFragments = (
  fragments: readonly ContextVariableRenderCandidate[],
  config: ContextVariableRenderBoundConfig,
): ContextVariableBoundResult => {
  const clamped: ContextVariableBoundClamp[] = [];
  const candidates = fragments.map((fragment) => {
    const value = clampValue(fragment.value, config.perValueMaxChars);
    if (value.length !== fragment.value.length) {
      clamped.push({
        variableName: fragment.name,
        originalChars: fragment.value.length,
        retainedChars: value.length,
      });
    }
    return { ...fragment, value };
  });

  const kept: ContextVariableRenderCandidate[] = [];
  const dropped: ContextVariableBoundDrop[] = [];
  let usedTokens = 0;
  let budgetExhausted = false;

  for (const [index, fragment] of candidates.entries()) {
    if (index >= config.maxRenderedVariables) {
      dropped.push({ variableName: fragment.name, reason: "count_cap" });
      continue;
    }
    const cost = estimateTokens(fragment);
    if (budgetExhausted || (kept.length > 0 && usedTokens + cost > config.sectionTokenBudget)) {
      budgetExhausted = true;
      dropped.push({ variableName: fragment.name, reason: "token_budget" });
      continue;
    }
    usedTokens += cost;
    kept.push(fragment);
  }

  return { kept, dropped, clamped };
};
