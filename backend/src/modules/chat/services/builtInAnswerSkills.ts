import {
  clarificationAnswerSkillDefinition,
  directAnswerSkillDefinition,
  retrievalAnswerSkillDefinition,
} from "../../skills/public.js";

/** Runtime registration shared with the read-only agent Skills presentation. */
export const builtInAnswerSkills = {
  clarification: clarificationAnswerSkillDefinition.name,
  retrieval: retrievalAnswerSkillDefinition.name,
  direct: directAnswerSkillDefinition.name,
} as const;

export const builtInAnswerSkillNames = Object.values(builtInAnswerSkills);
