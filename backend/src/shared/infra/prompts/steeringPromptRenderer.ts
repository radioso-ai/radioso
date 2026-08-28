import { GENERATION_SURFACE, type GenerationSurface } from "../../domain/generationSurface.js";
import {
  appendSteeringRules,
  renderSteeringRules,
  steeringForSurface,
  type RenderSteeringRulesOptions,
  type SteeringRule,
} from "../../domain/steeringRule.js";
import { loadPromptTemplate } from "./promptLoader.js";

export interface SteeringBlockRenderOptions extends Pick<RenderSteeringRulesOptions, "includeRuleIds"> {
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

export const renderSteeringBlock = (
  steering: SteeringRule[] = [],
  options: SteeringBlockRenderOptions = {},
): string =>
  renderSteeringRules(
    steeringForSurface(steering, options.surface ?? GENERATION_SURFACE.ANSWER),
    surfaceOptions(options),
  );

export const appendSteeringBlock = (
  prompt: string,
  steering: SteeringRule[] = [],
  options: SteeringBlockRenderOptions = {},
): string =>
  appendSteeringRules(
    prompt,
    steeringForSurface(steering, options.surface ?? GENERATION_SURFACE.ANSWER),
    surfaceOptions(options),
  );
