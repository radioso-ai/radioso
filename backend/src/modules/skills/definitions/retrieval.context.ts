import type { SkillDefinition } from "../domain.js";
import { loadSkillDefinition } from "./loadSkillDefinition.js";

export const retrievalContextSkillDefinition: SkillDefinition = loadSkillDefinition(
  new URL("./retrieval.context/", import.meta.url),
);
