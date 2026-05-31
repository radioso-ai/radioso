import type { SkillDefinition } from "../domain.js";
import { loadSkillDefinition } from "./loadSkillDefinition.js";

export const retrievalSearchSkillDefinition: SkillDefinition = loadSkillDefinition(
  new URL("./retrieval.search/", import.meta.url),
);
