import {
  clarificationAnswerSkillDefinition,
  directAnswerSkillDefinition,
  retrievalAnswerSkillDefinition,
} from "../../skills/public.js";

/** Runtime registration shared with the read-only agent Skills presentation. */
export const builtInAnswerSkillDefinitions = [
  clarificationAnswerSkillDefinition,
  retrievalAnswerSkillDefinition,
  directAnswerSkillDefinition,
] as const;

const [clarificationAnswerSkill, retrievalAnswerSkill, directAnswerSkill] = builtInAnswerSkillDefinitions;

export const builtInAnswerSkills = {
  clarification: clarificationAnswerSkill.name,
  retrieval: retrievalAnswerSkill.name,
  direct: directAnswerSkill.name,
} as const;
