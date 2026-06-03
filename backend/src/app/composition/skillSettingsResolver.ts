import { badRequest } from "../../shared/domain/errors.js";
import {
  normalizeRetrievalSkillSettingsOverride,
  type EffectiveRetrievalSkillSettings,
  type RetrievalSkillSettingsOverride,
} from "../../modules/retrieval/domain/retrievalSkillSettings.js";
import {
  normalizeMetadataRules,
  type RetrievalSettingsRecord,
} from "../../modules/settings/contracts/retrieval.js";
import { AgentSkillSettingsRegistry } from "../../modules/agents/public.js";
import type { SkillSettingsResolver } from "../../modules/retrieval/services/retrievalContextStage.js";

export const createRetrievalSkillSettingsResolver = (): SkillSettingsResolver => ({
  resolve(skill, defaults, agentOverride) {
    if (skill !== "retrieval.answer") {
      return defaults;
    }
    if (agentOverride === undefined || agentOverride === null) {
      return defaults;
    }
    let override: RetrievalSkillSettingsOverride;
    try {
      override = normalizeRetrievalSkillSettingsOverride(agentOverride);
    } catch (error) {
      const message = error instanceof Error ? error.message : "retrieval.answer settings are invalid";
      throw badRequest(message);
    }
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
  });
  return registry;
};
