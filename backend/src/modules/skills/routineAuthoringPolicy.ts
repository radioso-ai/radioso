import type { SkillCatalogEntryDefinition } from "./domain.js";
import { retrievalAnswerSkillDefinition } from "./definitions/retrieval.answer.js";

export const routineSkillCategories = [
  "retrieval",
  "built_in",
  "external_mcp",
  "customer_email",
] as const;

export type RoutineSkillCategory = (typeof routineSkillCategories)[number];

export const routineDispatchableBuiltInSkillNames = [
  retrievalAnswerSkillDefinition.name,
] as const;

const routineDispatchableBuiltInSkillNameSet = new Set<string>(routineDispatchableBuiltInSkillNames);

export const routineDispatchableBuiltInSkills = [retrievalAnswerSkillDefinition] as const;

export const isRoutineDispatchableBuiltInSkill = (
  skill: Pick<SkillCatalogEntryDefinition, "name">,
): boolean => routineDispatchableBuiltInSkillNameSet.has(skill.name);

export const routineSkillCategoryForBuiltIn = (
  skill: Pick<SkillCatalogEntryDefinition, "owner">,
): RoutineSkillCategory => skill.owner === "retrieval" ? "retrieval" : "built_in";
