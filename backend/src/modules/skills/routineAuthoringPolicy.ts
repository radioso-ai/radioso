import type { SkillCatalogEntryDefinition } from "./domain.js";
import { retrievalAnswerSkillDefinition } from "./definitions/retrieval.answer.js";
import { retrievalContextSkillDefinition } from "./definitions/retrieval.context.js";

export const routineSkillCategories = [
  "retrieval",
  "built_in",
  "external_mcp",
  "customer_email",
  "webhook",
  "slack",
  "notify",
] as const;

export type RoutineSkillCategory = (typeof routineSkillCategories)[number];

export const routineDispatchableBuiltInSkillNames = [
  retrievalAnswerSkillDefinition.name,
  retrievalContextSkillDefinition.name,
] as const;

const routineDispatchableBuiltInSkillNameSet = new Set<string>(routineDispatchableBuiltInSkillNames);

export const routineDispatchableBuiltInSkills = [retrievalAnswerSkillDefinition, retrievalContextSkillDefinition] as const;

export const routineAuthoringBuiltInSkillNames = [
  retrievalContextSkillDefinition.name,
] as const;

const routineAuthoringBuiltInSkillNameSet = new Set<string>(routineAuthoringBuiltInSkillNames);

export const routineAuthoringBuiltInSkills = [retrievalContextSkillDefinition] as const;

export const isRoutineDispatchableBuiltInSkill = (
  skill: Pick<SkillCatalogEntryDefinition, "name">,
): boolean => routineDispatchableBuiltInSkillNameSet.has(skill.name);

export const isRoutineAuthoringBuiltInSkill = (
  skill: Pick<SkillCatalogEntryDefinition, "name">,
): boolean => routineAuthoringBuiltInSkillNameSet.has(skill.name);

export const routineSkillCategoryForBuiltIn = (
  skill: Pick<SkillCatalogEntryDefinition, "owner">,
): RoutineSkillCategory => skill.owner === "retrieval" ? "retrieval" : "built_in";
