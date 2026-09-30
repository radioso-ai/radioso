import { GENERATION_SURFACE, type GenerationSurface } from "../../domain/generationSurface.js";
import {
  appendSteeringRules,
  partitionRoutineStepSteering,
  renderRoutineStepInstructions,
  renderSteeringRules,
  routineStepSteeringOptions,
  steeringForSurface,
  type RenderSteeringRulesOptions,
  type SteeringRule,
} from "../../domain/steeringRule.js";
import { loadPromptTemplate, renderPromptTemplate } from "./promptLoader.js";

interface SteeringBlockRenderOptions extends Pick<RenderSteeringRulesOptions, "includeRuleIds"> {
  /** Generator these rules are being rendered for. Defaults to the answering voice. */
  surface?: GenerationSurface;
}

/** Prompt that frames the rules for each surface's own generator. */
const SURFACE_TEMPLATES: Record<GenerationSurface, string> = {
  [GENERATION_SURFACE.ANSWER]: "chat/steering.md",
  [GENERATION_SURFACE.SUGGESTED_QUESTIONS]: "chat/steering-suggested-questions.md",
};

/**
 * Host adapter over the package renderer: narrows the turn's steering to the rules
 * addressed to one generator, and supplies that generator's framing from
 * `backend/prompts/` so an operator prompt edit takes effect without regenerating the
 * package default. Ordering and line format live in the package, shared with every
 * other surface that renders steering.
 */
const surfaceOptions = (options: SteeringBlockRenderOptions): RenderSteeringRulesOptions => {
  const templateName = SURFACE_TEMPLATES[options.surface ?? GENERATION_SURFACE.ANSWER];
  return {
    includeRuleIds: options.includeRuleIds,
    template: loadPromptTemplate(templateName),
    templateName,
  };
};

const surfaceRules = (steering: SteeringRule[], options: SteeringBlockRenderOptions): SteeringRule[] =>
  steeringForSurface(steering, options.surface ?? GENERATION_SURFACE.ANSWER);

/**
 * A routine chat step fed by a retrieval step composes its reply through the answer
 * generators, which render the step's steering here (#1351). When a routine step's
 * rule is present it controls the reply, as it does in the step renderer, and
 * directives render through the same subordinate framing
 * (`chat/routine-step-steering.md`) inside `chat/routine-step-answer-steering.md`.
 * That layout opens with the step instruction and closes with a reminder to finish
 * it: with the instruction after the rules, a grounded answer followed it literally
 * and dropped the rules' tone and openings; without the reminder, it often answered
 * and stopped before the step's question. Undefined without a routine rule, so every
 * other answer renders exactly the generic block.
 */
const renderRoutineStepBlock = (rules: SteeringRule[], options: SteeringBlockRenderOptions): string | undefined => {
  const { instructions, guidance } = partitionRoutineStepSteering(rules);
  if (instructions.length === 0) {
    return undefined;
  }
  const guidanceBlock = renderSteeringRules(guidance, {
    ...routineStepSteeringOptions(loadPromptTemplate("chat/routine-step-steering.md")),
    includeRuleIds: options.includeRuleIds,
  });
  return renderPromptTemplate("chat/routine-step-answer-steering.md", {
    instructions: renderRoutineStepInstructions(instructions.map((rule) => rule.action)),
    subordinate_guidance: guidanceBlock ? `${guidanceBlock}\n\n` : "",
  });
};

export const renderSteeringBlock = (
  steering: SteeringRule[] = [],
  options: SteeringBlockRenderOptions = {},
): string => {
  const rules = surfaceRules(steering, options);
  return renderRoutineStepBlock(rules, options) ?? renderSteeringRules(rules, surfaceOptions(options));
};

export const appendSteeringBlock = (
  prompt: string,
  steering: SteeringRule[] = [],
  options: SteeringBlockRenderOptions = {},
): string => {
  const rules = surfaceRules(steering, options);
  const routineStepBlock = renderRoutineStepBlock(rules, options);
  return routineStepBlock === undefined
    ? appendSteeringRules(prompt, rules, surfaceOptions(options))
    : `${prompt}\n\n${routineStepBlock}`;
};
