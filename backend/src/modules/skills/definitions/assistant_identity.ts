import type { SkillDefinition } from "../domain.js";
import { loadSkillDefinition } from "./loadSkillDefinition.js";

export const assistantIdentityAnswerSkillDefinition: SkillDefinition = loadSkillDefinition(
  new URL("./assistant_identity/", import.meta.url),
);
