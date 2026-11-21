import type { RoutineStepSkillResult } from "@radioso/conversation-contract";
import { renderSkillOutputLines } from "@radioso/conversation-contract";

import { renderPromptTemplate } from "./promptTemplate.js";

/** A skill name or outcome status the facts carry as it is: an identifier, never free text. */
export const IDENTIFIER_TOKEN = /^[\w.:-]{1,128}$/u;

/** Whether an output came back: an empty list counts as none, as a field guard reads it. */
const returned = (value: unknown): boolean =>
  value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0);

/**
 * One result under its tool and outcome: the outputs its contract declares as typed, described
 * lines, or that it returned no values when none came back. Decided from the outputs' structure,
 * never from what a value says.
 */
const resultSection = ({ skillName, status, outputs, outputContract }: RoutineStepSkillResult): string => {
  const head = `\`${skillName}\` → \`${status}\``;
  const declared = Object.fromEntries(Object.entries(outputs).filter(([name]) => Object.hasOwn(outputContract, name)));
  if (!Object.values(declared).some(returned)) {
    return `${head}: returned no values`;
  }
  return [`${head}:`, ...renderSkillOutputLines(declared, outputContract)].join("\n");
};

/**
 * What this turn's tool steps returned, for the reply of a step after them (#1883): told only that
 * a customer lookup completed, an ending meant to give the customer's name said nothing was found.
 * Only results whose skill declares an output contract reach here, with only the outputs it
 * declares, never raw JSON; a tool name or status that is no identifier is left out. Empty when
 * there are none, so a turn without such a result reads as it did before.
 */
export const toolResultsBlock = (skillResults: readonly RoutineStepSkillResult[] | undefined, template: string): string => {
  const results = (skillResults ?? []).filter(({ skillName, status }) => IDENTIFIER_TOKEN.test(skillName) && IDENTIFIER_TOKEN.test(status));
  return results.length > 0
    ? renderPromptTemplate("chat/routine-step-tool-results.md", template, { tool_results: results.map(resultSection).join("\n\n") })
    : "";
};
