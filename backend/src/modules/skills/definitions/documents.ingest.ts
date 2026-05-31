import type { SkillDefinition } from "../domain.js";
import { loadSkillDefinition } from "./loadSkillDefinition.js";

export const documentsIngestSkillDefinition: SkillDefinition = loadSkillDefinition(
  new URL("./documents.ingest/", import.meta.url),
);
