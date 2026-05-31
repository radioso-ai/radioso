import { orderSteeringRules, type SteeringRule } from "../../../shared/domain/steeringRule.js";
import { renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";

export const renderSteeringBlock = (steering: SteeringRule[] = []): string => {
  if (steering.length === 0) {
    return "";
  }
  const lines = orderSteeringRules(steering)
    .map((rule) => (rule.condition ? `- ${rule.action} (when: ${rule.condition})` : `- ${rule.action}`))
    .join("\n");
  return renderPromptTemplate("chat/steering.md", { steering_rules: lines });
};

export const appendSteeringBlock = (prompt: string, steering: SteeringRule[] = []): string => {
  const steeringBlock = renderSteeringBlock(steering);
  return steeringBlock ? `${prompt}\n\n${steeringBlock}` : prompt;
};
