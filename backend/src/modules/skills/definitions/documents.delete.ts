import type { SkillDefinition } from "../domain.js";
import { loadSkillDefinition } from "./loadSkillDefinition.js";

export const documentsDeleteSkillDefinition: SkillDefinition = loadSkillDefinition(
  new URL("./documents.delete/", import.meta.url),
);
