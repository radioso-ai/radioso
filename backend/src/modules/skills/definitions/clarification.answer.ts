import type { SkillDefinition } from "../domain.js";
import { loadSkillDefinition } from "./loadSkillDefinition.js";

export const clarificationAnswerSkillDefinition: SkillDefinition = loadSkillDefinition(
  new URL("./clarification.answer/", import.meta.url),
);
