import { SkillCatalogRegistry } from "@radioso/conversation-defaults";
import { type SkillCatalogEntryDefinition } from "./domain.js";
import { assistantChatSkillDefinition } from "./definitions/assistant.chat.js";
import { retrievalSearchSkillDefinition } from "./definitions/retrieval.search.js";
import { retrievalAnswerSkillDefinition } from "./definitions/retrieval.answer.js";
import { directAnswerSkillDefinition } from "./definitions/direct.js";
import { documentsIngestSkillDefinition } from "./definitions/documents.ingest.js";
import { documentsSearchSkillDefinition } from "./definitions/documents.search.js";
import { documentsDeleteSkillDefinition } from "./definitions/documents.delete.js";
import { mcpDescribeCapabilitiesSkillDefinition } from "./definitions/mcp.describe_capabilities.js";

export const customerEmailSkillCatalogEntry: SkillCatalogEntryDefinition = {
  name: "customer_email.skill",
  displayName: "Customer email skill",
  description: "Invoke allowlisted customer-owned email draft/send skills through a workspace email connection.",
  display: { icon: "mail", title: "Customer email" },
  owner: "platform",
  executionClass: "interactive",
  supportedCallers: ["assistant"],
  requiredCapabilities: ["external_skills.invoke"],
  contractReferences: [{
    kind: "documentation",
    label: "Customer email skills",
    path: "/docs/customer-email-skills",
  }],
  diagnostics: {
    defined: true,
    shapeAware: false,
    strategyAware: false,
  },
  outcomes: [
    { name: "drafted", displayName: "Drafted", status: "completed", tone: "positive" },
    { name: "sent", displayName: "Sent", status: "completed", tone: "positive" },
    { name: "missing_input", displayName: "Missing input", status: "failed", tone: "warning" },
    { name: "disabled_connection", displayName: "Disabled connection", status: "failed", tone: "warning" },
    { name: "needs_reauth", displayName: "Needs reauthorization", status: "failed", tone: "warning" },
    { name: "provider_rejected", displayName: "Provider rejected", status: "failed", tone: "warning" },
    { name: "failed", displayName: "Failed", status: "failed", tone: "warning" },
  ],
};

// Every built-in skill is a declarative `skill.json` under `definitions/`, loaded
// via `loadSkillDefinition`. The catalog assembles them; it owns no skill data.
export const builtInSkillCatalogEntries: SkillCatalogEntryDefinition[] = [
  assistantChatSkillDefinition,
  retrievalSearchSkillDefinition,
  retrievalAnswerSkillDefinition,
  directAnswerSkillDefinition,
  documentsIngestSkillDefinition,
  documentsSearchSkillDefinition,
  documentsDeleteSkillDefinition,
  mcpDescribeCapabilitiesSkillDefinition,
  customerEmailSkillCatalogEntry,
];

export const createDefaultSkillCatalogRegistry = (
  additionalEntries: SkillCatalogEntryDefinition[] = [],
): SkillCatalogRegistry<SkillCatalogEntryDefinition> =>
  new SkillCatalogRegistry([...builtInSkillCatalogEntries, ...additionalEntries]);
