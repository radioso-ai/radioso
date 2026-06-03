import type { Directive } from "./domain.js";

export const DEFAULT_DIRECTIVE_MATCH_SYSTEM_PROMPT = `You decide which behavioral directives apply to the current conversation turn.

You are given a list of candidate directives. Each has a \`name\` and a
\`condition\` describing when it should apply. You are also given the current
turn's signals (such as the user's latest message).

Decide which directives' conditions hold for this turn. A condition may be
written in any language and the turn may be in any language; judge by meaning,
not by matching words.

Return a JSON array. Include one object only for each directive whose condition
holds:

[{"name": "<directive name>", "confidence": <number between 0 and 1>, "reason": "<short reason>"}]

Rules:

- Use only the directive names provided. Do not invent names.
- Omit directives whose conditions do not hold.
- \`confidence\` reflects how strongly the condition holds (1 = certain).
- If no directive applies, return an empty array: []
- Return only the JSON array, with no other text.`;

/** System prompt instructing the model how to decide which directives apply. */
export const getDirectiveMatchSystemPrompt = (override?: string): string =>
  override ?? DEFAULT_DIRECTIVE_MATCH_SYSTEM_PROMPT;

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
