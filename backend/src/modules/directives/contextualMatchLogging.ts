import type { DirectiveSteeringLogger } from "./directiveSteeringService.js";

/**
 * Where the contextual classification for a turn was meant to come from, and so
 * which step of the contextual path gave up. `gateway_construction` is the step
 * that resolves workspace LLM capability config; `model_gateway` is the
 * classification call made through the resolved gateway.
 */
export type ContextualClassificationSource =
  | "precomputed_classifications"
  | "gateway_construction"
  | "model_gateway";

/**
 * Builds the observer passed to `ProbabilisticDirectiveMatcher`, which degrades to
 * zero contextual matches when its classification call fails. The degradation is
 * silent by design — the matcher is a portable library with no log sink — so every
 * host construction site reports it through this one helper.
 *
 * Log-safe by construction: it accepts identifiers and the error only. The
 * directive turn context, which carries the user query and conversation content,
 * is never in scope here and must not be added.
 */
export const reportContextualMatchUnavailable = (deps: {
  logger?: DirectiveSteeringLogger;
  source: ContextualClassificationSource;
  workspaceId?: string;
}) => (error: unknown): void => {
  deps.logger?.warn(
    {
      event: "directive_contextual_match_unavailable",
      ...(deps.workspaceId ? { workspaceId: deps.workspaceId } : {}),
      source: deps.source,
      // The error itself: the app logger's serializer keeps its class and code, never its
      // message, which a provider can fill with the text it rejected.
      err: error,
    },
    "Contextual directive matching unavailable; continuing with deterministic directives",
  );
};
