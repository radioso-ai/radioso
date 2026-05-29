/**
 * Retrieval execution strategy selection — the locus-of-control decision for
 * *how* the `retrieval.answer` skill is executed for a given turn.
 *
 * `fixed` runs the deterministic pipeline (the skill's declared steps in order);
 * `reasoning` runs the agent loop over the same capabilities. They are sibling
 * execution models that share only the output contract — there is no shared
 * base class.
 *
 * This is a pure decision: a controller calls it, then dispatches. The result
 * fills the `strategy`/`selectionMode`/`selectionReason`/`selectionConfidence`
 * slots that the skill diagnostic already exposes. `selectionMode` distinguishes
 * a config/request-pinned choice (`deterministic`) from a model/router-decided
 * one (`probabilistic`); the router is deferred, so today every choice is
 * `deterministic`.
 */

import {
  DEFAULT_RETRIEVAL_STRATEGY_PREFERENCE,
  resolveRetrievalStrategyPreference,
  type RetrievalStrategyPreference,
} from "../../settings/contracts/retrieval.js";

// The *preference* (fixed|reasoning|auto, including the deferred router) is
// owned by the settings module because it is persisted there; re-exported here
// so callers of the selector have one import. The *resolved* execution model
// below (fixed|reasoning, no `auto`) is a retrieval runtime concept.
export {
  DEFAULT_RETRIEVAL_STRATEGY_PREFERENCE,
  resolveRetrievalStrategyPreference,
  type RetrievalStrategyPreference,
};

export const retrievalStrategies = ["fixed", "reasoning"] as const;
export type RetrievalStrategy = (typeof retrievalStrategies)[number];

export type RetrievalStrategySelectionMode = "deterministic" | "probabilistic";

export interface RetrievalStrategySelection {
  strategy: RetrievalStrategy;
  selectionMode: RetrievalStrategySelectionMode;
  selectionReason: string;
  selectionConfidence?: number;
}

export interface RetrievalStrategySelectionInput {
  /** Persisted workspace-level preference. */
  workspacePreference?: RetrievalStrategyPreference | null;
  /** Per-request override; beats the workspace default when present. */
  requestOverride?: RetrievalStrategyPreference | null;
}

type PreferenceSource = "request" | "workspace" | "system_default";

export const selectRetrievalStrategy = (
  input: RetrievalStrategySelectionInput,
): RetrievalStrategySelection => {
  const override = resolveRetrievalStrategyPreference(input.requestOverride);
  const workspace = resolveRetrievalStrategyPreference(input.workspacePreference);

  const { preference, source }: { preference: RetrievalStrategyPreference; source: PreferenceSource } =
    override
      ? { preference: override, source: "request" }
      : workspace
        ? { preference: workspace, source: "workspace" }
        : { preference: DEFAULT_RETRIEVAL_STRATEGY_PREFERENCE, source: "system_default" };

  if (preference === "auto") {
    // Router deferred: honor the intent by resolving to the safe default. When
    // the router ships, this branch becomes `selectionMode: "probabilistic"`
    // with a confidence — the diagnostic slots already accommodate it.
    return {
      strategy: "fixed",
      selectionMode: "deterministic",
      selectionReason:
        "Automatic strategy routing is not yet available; defaulting to the fixed retrieval strategy.",
    };
  }

  return {
    strategy: preference,
    selectionMode: "deterministic",
    selectionReason: reasonFor(preference, source),
  };
};

const reasonFor = (strategy: RetrievalStrategy, source: PreferenceSource): string => {
  switch (source) {
    case "request":
      return `Request override pinned the ${strategy} retrieval strategy.`;
    case "workspace":
      return `Workspace default selected the ${strategy} retrieval strategy.`;
    case "system_default":
      return `No strategy preference configured; defaulting to the ${strategy} retrieval strategy.`;
  }
};
