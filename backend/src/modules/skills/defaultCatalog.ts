import { capabilityNames } from "../../shared/domain/capabilityPolicy.js";
import { skillDiagnosticFieldNames, type SkillCatalogEntryDefinition } from "./domain.js";
import { retrievalAnswerSkillDefinition } from "./definitions/retrieval.answer.js";
import { socialAnswerSkillDefinition } from "./definitions/social_only.js";
import { assistantIdentityAnswerSkillDefinition } from "./definitions/assistant_identity.js";
import { SkillCatalogRegistry } from "./skillCatalogRegistry.js";

const diagnostics = {
  defined: true,
  shapeAware: false,
  strategyAware: false,
  supportedFields: [...skillDiagnosticFieldNames],
};

const legacyStrategyDiagnostics = {
  ...diagnostics,
  strategyAware: true,
};

export const builtInSkillCatalogEntries: SkillCatalogEntryDefinition[] = [
  {
    name: "assistant.chat",
    displayName: "Assistant chat",
    description: "Run human-facing assistant chat with assistant-owned routing and conversation behavior.",
    owner: "assistant",
    executionClass: "interactive",
    supportedCallers: ["assistant", "dashboard", "public_embed", "sdk"],
    requiredCapabilities: [capabilityNames.assistant.chat],
    contractReferences: [
      {
        kind: "http",
        label: "Assistant chat API",
        method: "POST",
        path: "/api/v1/assistant/chat",
      },
      {
        kind: "sdk",
        label: "TypeScript SDK assistant chat",
        path: "chat.stream",
      },
    ],
    diagnostics: legacyStrategyDiagnostics,
    outcomes: [
      {
        name: "conversational",
        displayName: "Conversational response",
        description: "The assistant answered without invoking a skill-specific action.",
        status: "completed",
        tone: "info",
      },
    ],
  },
  {
    name: "retrieval.search",
    displayName: "Retrieval search",
    description: "Search workspace evidence without assistant persona or social behavior.",
    owner: "retrieval",
    executionClass: "interactive",
    supportedCallers: ["retrieval_api", "sdk"],
    requiredCapabilities: [capabilityNames.retrieval.search],
    contractReferences: [
      {
        kind: "http",
        label: "Retrieval search API",
        method: "POST",
        path: "/api/v1/retrieval/search",
      },
    ],
    diagnostics: legacyStrategyDiagnostics,
  },
  retrievalAnswerSkillDefinition,
  socialAnswerSkillDefinition,
  assistantIdentityAnswerSkillDefinition,
  {
    name: "documents.ingest",
    displayName: "Document ingestion",
    description: "Add workspace documents for asynchronous processing and future retrieval.",
    owner: "documents",
    executionClass: "deferred",
    supportedCallers: ["dashboard", "sdk", "mcp"],
    requiredCapabilities: [capabilityNames.documents.ingest],
    contractReferences: [
      {
        kind: "http",
        label: "Document upload API",
        method: "POST",
        path: "/api/v1/document",
      },
      {
        kind: "mcp_tool",
        label: "MCP create document tool",
        path: "create_document",
      },
    ],
    diagnostics,
  },
  {
    name: "documents.search",
    displayName: "Document search",
    description: "Search indexed workspace documents and history-oriented search records.",
    owner: "documents",
    executionClass: "interactive",
    supportedCallers: ["dashboard", "sdk", "mcp"],
    requiredCapabilities: [capabilityNames.documents.search],
    contractReferences: [
      {
        kind: "http",
        label: "Document search API",
        method: "POST",
        path: "/api/v1/document/search",
      },
      {
        kind: "mcp_tool",
        label: "MCP document search tool",
        path: "search_documents",
      },
    ],
    diagnostics,
  },
  {
    name: "documents.delete",
    displayName: "Document deletion",
    description: "Delete a workspace document after capability policy allows the action.",
    owner: "documents",
    executionClass: "administrative",
    supportedCallers: ["dashboard", "sdk", "mcp"],
    requiredCapabilities: [capabilityNames.documents.delete],
    availabilityCheck: "capability_policy",
    contractReferences: [
      {
        kind: "http",
        label: "Document delete API",
        method: "DELETE",
        path: "/api/v1/document/{documentId}",
      },
      {
        kind: "mcp_tool",
        label: "MCP delete document tool",
        path: "delete_document",
      },
    ],
    diagnostics,
  },
  {
    name: "mcp.describe_capabilities",
    displayName: "MCP capability discovery",
    description: "Describe read and write tools available from the Radioso MCP server.",
    owner: "mcp",
    executionClass: "interactive",
    supportedCallers: ["mcp"],
    requiredCapabilities: [capabilityNames.mcp.describeCapabilities],
    contractReferences: [
      {
        kind: "mcp_tool",
        label: "MCP describe capabilities tool",
        path: "describe_capabilities",
      },
      {
        kind: "documentation",
        label: "MCP client setup",
        path: "docs/mcp-client-setup.md",
      },
    ],
    diagnostics,
  },
];

export const createDefaultSkillCatalogRegistry = (
  additionalEntries: SkillCatalogEntryDefinition[] = [],
): SkillCatalogRegistry =>
  new SkillCatalogRegistry([...builtInSkillCatalogEntries, ...additionalEntries]);
