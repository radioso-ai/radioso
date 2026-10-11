import {
  normalizeRetrievalSkillSettingsOverride,
  parsePersistedRetrievalSkillSettingsOverride,
  resolveRetrievalSkillSettings,
} from "../../modules/retrieval/public.js";
import { AgentSkillSettingsRegistry } from "../../modules/agents/public.js";
import type { SkillSettingsResolver } from "../../modules/retrieval/public.js";

export const createRetrievalSkillSettingsResolver = (): SkillSettingsResolver => ({
  resolve(skill, defaults, agentOverride) {
    if (skill !== "retrieval.answer") {
      return defaults;
    }
    return resolveRetrievalSkillSettings(defaults, agentOverride);
  },
});

export const createDefaultAgentSkillSettingsRegistry = (): AgentSkillSettingsRegistry => {
  const registry = new AgentSkillSettingsRegistry();
  registry.register({
    skillName: "retrieval.answer",
    normalize: normalizeRetrievalSkillSettingsOverride,
    parse: parsePersistedRetrievalSkillSettingsOverride,
  });
  return registry;
};
