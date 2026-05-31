import type { SkillDefinition } from "../domain.js";
import { loadSkillDefinition } from "./loadSkillDefinition.js";

export const documentsSearchSkillDefinition: SkillDefinition = loadSkillDefinition(
  new URL("./documents.search/", import.meta.url),
);
