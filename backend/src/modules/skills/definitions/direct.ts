import type { SkillDefinition } from "../domain.js";
import { loadSkillDefinition } from "./loadSkillDefinition.js";

export const directAnswerSkillDefinition: SkillDefinition = loadSkillDefinition(
  new URL("./direct/", import.meta.url),
);
