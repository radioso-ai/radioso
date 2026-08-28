import { orderSteeringRules, type SteeringRule } from "./domain.js";
import { renderPromptTemplate } from "./promptTemplate.js";
import {
  DEFAULT_CLARIFICATION_STEERING_PROMPT,
  DEFAULT_STEERING_PROMPT,
} from "./generated/defaultPrompts.js";

export {
  DEFAULT_CLARIFICATION_STEERING_PROMPT,
  DEFAULT_STEERING_PROMPT,
} from "./generated/defaultPrompts.js";

export interface RenderSteeringRulesOptions {
  /**
   * Prompt text framing the rules for the surface that renders them. Each surface
   * addresses its own generator ("when forming your response" vs "when phrasing the
   * question"), so the framing is a parameter while ordering and line format are not.
   */
  template?: string;
  /** Template identity used only for the missing-variable error message. */
  templateName?: string;
  /** Bracketed rule ids, for surfaces that ask the model to attest which rules it applied. */
  includeRuleIds?: boolean;
}

const formatRule = (rule: SteeringRule, includeRuleIds: boolean): string => {
  const prefix = includeRuleIds && rule.id ? `- [${rule.id}] ` : "- ";
  return rule.condition ? `${prefix}${rule.action} (when: ${rule.condition})` : `${prefix}${rule.action}`;
};

/**
 * Renders standing behavioral rules into a prompt block. Empty when nothing applies,
 * so a caller can append unconditionally.
 */
export const renderSteeringRules = (
  steering: SteeringRule[] = [],
  options: RenderSteeringRulesOptions = {},
): string => {
  if (steering.length === 0) {
    return "";
  }
  const lines = orderSteeringRules(steering)
    .map((rule) => formatRule(rule, options.includeRuleIds ?? false))
    .join("\n");
  return renderPromptTemplate(
    options.templateName ?? "chat/steering.md",
    options.template ?? DEFAULT_STEERING_PROMPT,
    { steering_rules: lines },
  );
};

export const appendSteeringRules = (
  prompt: string,
  steering: SteeringRule[] = [],
  options: RenderSteeringRulesOptions = {},
): string => {
  const block = renderSteeringRules(steering, options);
  return block ? `${prompt}\n\n${block}` : prompt;
};

export const clarificationSteeringOptions = (template?: string): RenderSteeringRulesOptions => ({
  template: template ?? DEFAULT_CLARIFICATION_STEERING_PROMPT,
  templateName: "chat/steering-clarification.md",
});
