import {
  normalizeRetrievalSkillSettingsOverride,
  parsePersistedRetrievalSkillSettingsOverride,
  type EffectiveRetrievalSkillSettings,
  type RetrievalSkillSettingsOverride,
} from "../../modules/retrieval/public.js";
import {
  normalizeMetadataRules,
  type RetrievalSettingsRecord,
} from "../../modules/settings/contracts/retrieval.js";
import { AgentSkillSettingsRegistry } from "../../modules/agents/public.js";
import type { SkillSettingsResolver } from "../../modules/retrieval/public.js";

export const createRetrievalSkillSettingsResolver = (): SkillSettingsResolver => ({
  resolve(skill, defaults, agentOverride) {
    if (skill !== "retrieval.answer") {
      return defaults;
    }
    if (agentOverride === undefined || agentOverride === null) {
      return defaults;
    }
    const override = parsePersistedRetrievalSkillSettingsOverride(agentOverride);
    const { metadataRules, ...rest } = override;
    return {
      ...defaults,
      ...rest,
      ...(metadataRules !== undefined ? { metadataRules: normalizeMetadataRules(metadataRules) } : {}),
      workspaceId: defaults.workspaceId,
    };
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
