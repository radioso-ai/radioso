import type { SkillDefinition } from "../domain.js";
import { loadSkillDefinition } from "./loadSkillDefinition.js";

export const socialAnswerSkillDefinition: SkillDefinition = loadSkillDefinition(
  new URL("./social_only/", import.meta.url),
);
