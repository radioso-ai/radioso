import { loadPromptTemplate } from "../../shared/infra/prompts/promptLoader.js";

import type { Directive } from "./domain.js";

/** System prompt instructing the model how to decide which directives apply. */
export const getDirectiveMatchSystemPrompt = (): string => loadPromptTemplate("chat/directive-match.md");

/**
 * Builds the user prompt: the candidate contextual directives (name + the
 * condition the model evaluates) and the turn signals. Directive `action`s are
 * intentionally omitted — the model decides *whether* a directive applies, not
 * what it instructs.
 */
export const buildDirectiveMatchPrompt = (input: {
  turnContext: Record<string, unknown>;
  directives: Directive[];
}): string => {
  const candidates = input.directives.map((directive) => ({
    name: directive.name,
    condition: directive.condition.kind === "contextual" ? directive.condition.description : "",
  }));

  return [
    "Candidate directives:",
    JSON.stringify(candidates, null, 2),
    "",
    "Current turn signals:",
    JSON.stringify(input.turnContext, null, 2),
  ].join("\n");
};
