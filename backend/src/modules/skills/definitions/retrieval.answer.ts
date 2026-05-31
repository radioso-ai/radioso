import type { SkillDefinition } from "../domain.js";
import { loadSkillDefinition } from "./loadSkillDefinition.js";

export const retrievalAnswerSkillDefinition: SkillDefinition = loadSkillDefinition(
  new URL("./retrieval.answer/", import.meta.url),
);
