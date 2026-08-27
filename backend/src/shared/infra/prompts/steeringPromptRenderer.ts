import {
  appendSteeringRules,
  renderSteeringRules,
  type RenderSteeringRulesOptions,
  type SteeringRule,
} from "../../domain/steeringRule.js";
import { loadPromptTemplate } from "./promptLoader.js";

export type SteeringBlockRenderOptions = Pick<RenderSteeringRulesOptions, "includeRuleIds">;

/**
 * Host adapter over the package renderer: supplies the answer-surface framing from
 * `backend/prompts/`, so an operator prompt edit takes effect without regenerating
 * the package default. Ordering and line format live in the package, shared with
 * every other surface that renders steering.
 */
const answerSurfaceOptions = (options: SteeringBlockRenderOptions): RenderSteeringRulesOptions => ({
  ...options,
  template: loadPromptTemplate("chat/steering.md"),
  templateName: "chat/steering.md",
});

export const renderSteeringBlock = (
  steering: SteeringRule[] = [],
  options: SteeringBlockRenderOptions = {},
): string => renderSteeringRules(steering, answerSurfaceOptions(options));

export const appendSteeringBlock = (prompt: string, steering: SteeringRule[] = []): string =>
  appendSteeringRules(prompt, steering, answerSurfaceOptions({}));
