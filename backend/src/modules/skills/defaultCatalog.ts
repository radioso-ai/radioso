import { type SkillCatalogEntryDefinition } from "./domain.js";
import { assistantChatSkillDefinition } from "./definitions/assistant.chat.js";
import { retrievalSearchSkillDefinition } from "./definitions/retrieval.search.js";
import { retrievalAnswerSkillDefinition } from "./definitions/retrieval.answer.js";
import { socialAnswerSkillDefinition } from "./definitions/social_only.js";
import { assistantIdentityAnswerSkillDefinition } from "./definitions/assistant_identity.js";
import { documentsIngestSkillDefinition } from "./definitions/documents.ingest.js";
import { documentsSearchSkillDefinition } from "./definitions/documents.search.js";
import { documentsDeleteSkillDefinition } from "./definitions/documents.delete.js";
import { mcpDescribeCapabilitiesSkillDefinition } from "./definitions/mcp.describe_capabilities.js";
import { SkillCatalogRegistry } from "./skillCatalogRegistry.js";

// Every built-in skill is a declarative `skill.json` under `definitions/`, loaded
// via `loadSkillDefinition`. The catalog assembles them; it owns no skill data.
export const builtInSkillCatalogEntries: SkillCatalogEntryDefinition[] = [
  assistantChatSkillDefinition,
  retrievalSearchSkillDefinition,
  retrievalAnswerSkillDefinition,
  socialAnswerSkillDefinition,
  assistantIdentityAnswerSkillDefinition,
  documentsIngestSkillDefinition,
  documentsSearchSkillDefinition,
  documentsDeleteSkillDefinition,
  mcpDescribeCapabilitiesSkillDefinition,
];

export const createDefaultSkillCatalogRegistry = (
  additionalEntries: SkillCatalogEntryDefinition[] = [],
): SkillCatalogRegistry =>
  new SkillCatalogRegistry([...builtInSkillCatalogEntries, ...additionalEntries]);
