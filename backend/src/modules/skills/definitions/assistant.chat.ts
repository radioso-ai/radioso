import type { SkillDefinition } from "../domain.js";
import { loadSkillDefinition } from "./loadSkillDefinition.js";

export const assistantChatSkillDefinition: SkillDefinition = loadSkillDefinition(
  new URL("./assistant.chat/", import.meta.url),
);
