import { orderSteeringRules, type SteeringRule } from "../../domain/steeringRule.js";
import { renderPromptTemplate } from "./promptLoader.js";

export interface SteeringBlockRenderOptions {
  includeRuleIds?: boolean;
}

export const renderSteeringBlock = (
  steering: SteeringRule[] = [],
  options: SteeringBlockRenderOptions = {},
): string => {
  if (steering.length === 0) {
    return "";
  }
  const lines = orderSteeringRules(steering)
    .map((rule) => {
      const prefix = options.includeRuleIds && rule.id ? `- [${rule.id}] ` : "- ";
      return rule.condition ? `${prefix}${rule.action} (when: ${rule.condition})` : `${prefix}${rule.action}`;
    })
    .join("\n");
  return renderPromptTemplate("chat/steering.md", { steering_rules: lines });
};

export const appendSteeringBlock = (prompt: string, steering: SteeringRule[] = []): string => {
  const steeringBlock = renderSteeringBlock(steering);
  return steeringBlock ? `${prompt}\n\n${steeringBlock}` : prompt;
};
