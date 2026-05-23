module.exports = {
  // TODO: keep module-boundary coverage expanding as new modules expose public
  // contract entrypoints; each contract-owning module should get matching rules.
  forbidden: [
    {
      name: "no-direct-crawler-package-imports",
      severity: "error",
      comment:
        "Production code must access @radioso/crawler only through the website crawler provider adapter.",
      from: {
        path: "^src/",
        pathNot: [
          "^src/modules/websiteCrawler/radiosoCrawlerProvider\\.ts$",
        ],
      },
      to: {
        path: "^@radioso/crawler$",
      },
    },
    {
      name: "no-external-agents-nonpublic",
      severity: "error",
      comment:
        "Production code outside agents must import agent-owned symbols through agents public.ts.",
      from: {
        path: "^src/",
        pathNot: [
          "^src/modules/agents/",
        ],
      },
      to: {
        path: "^src/modules/agents/",
        pathNot: [
          "^src/modules/agents/public\\.ts$",
        ],
      },
    },
    {
      name: "no-external-skills-nonpublic",
      severity: "error",
      comment:
        "Production code outside skills must import skill-owned symbols through skills public.ts.",
      from: {
        path: "^src/",
        pathNot: [
          "^src/modules/skills/",
        ],
      },
      to: {
        path: "^src/modules/skills/",
        pathNot: [
          "^src/modules/skills/public\\.ts$",
        ],
      },
    },
    {
      name: "no-external-retrieval-nonpublic",
      severity: "error",
      comment:
        "Production code outside retrieval must import retrieval-owned symbols through retrieval public.ts or app composition.",
      from: {
        path: "^src/",
        pathNot: [
          "^src/modules/retrieval/",
        ],
      },
      to: {
        path: "^src/modules/retrieval/",
        pathNot: [
          "^src/modules/retrieval/(public|composition)\\.ts$",
        ],
      },
    },
    {
      name: "no-retrieval-composition-outside-app-wiring",
      severity: "error",
      comment:
        "The retrieval composition entrypoint is for application wiring only; other modules should use retrieval public.ts.",
      from: {
        path: "^src/",
        pathNot: [
          "^src/modules/retrieval/",
          "^src/app/server/(dependencies|dependencyBuilders|types)\\.ts$",
          "^src/app/composition/defaultComposition\\.ts$",
        ],
      },
      to: {
        path: "^src/modules/retrieval/composition\\.ts$",
      },
    },
    {
      name: "no-external-documents-internals",
      severity: "error",
      comment:
        "Production code outside documents must import document-owned symbols through documents contracts or composition entrypoints.",
      from: {
        path: "^src/",
        pathNot: [
          "^src/modules/documents/",
        ],
      },
      to: {
        path: "^src/modules/documents/(services|infra)/",
      },
    },
    {
      name: "no-unapproved-documents-root-entrypoints",
      severity: "error",
      comment:
        "Production code outside documents may only import approved documents root entrypoints.",
      from: {
        path: "^src/",
        pathNot: [
          "^src/modules/documents/",
        ],
      },
      to: {
        path: "^src/modules/documents/[^/]+\\.ts$",
        pathNot: [
          "^src/modules/documents/(composition|historySupport)\\.ts$",
        ],
      },
    },
    {
      name: "no-documents-composition-outside-app-wiring",
      severity: "error",
      comment:
        "The documents composition entrypoint is for application wiring only; other modules should use documents contracts.",
      from: {
        path: "^src/",
        pathNot: [
          "^src/modules/documents/",
          "^src/app/server/(dependencies|dependencyBuilders|types)\\.ts$",
          "^src/app/composition/defaultComposition\\.ts$",
        ],
      },
      to: {
        path: "^src/modules/documents/composition\\.ts$",
      },
    },
    {
      name: "no-documents-history-support-outside-chat-history",
      severity: "error",
      comment:
        "The documents history-support entrypoint is only for chat history presentation.",
      from: {
        path: "^src/",
        pathNot: [
          "^src/modules/documents/",
          "^src/modules/chat/services/historyItemPresenter\\.ts$",
        ],
      },
      to: {
        path: "^src/modules/documents/historySupport\\.ts$",
      },
    },
    {
      name: "no-external-chat-internals",
      severity: "error",
      comment:
        "Production code outside chat must import chat-owned symbols through chat contracts or approved entrypoints.",
      from: {
        path: "^src/",
        pathNot: [
          "^src/modules/chat/",
        ],
      },
      to: {
        path: "^src/modules/chat/(services|types)/",
      },
    },
    {
      name: "no-unapproved-chat-root-entrypoints",
      severity: "error",
      comment:
        "Production code outside chat may only import approved chat root entrypoints.",
      from: {
        path: "^src/",
        pathNot: [
          "^src/modules/chat/",
        ],
      },
      to: {
        path: "^src/modules/chat/[^/]+\\.ts$",
        pathNot: [
          "^src/modules/chat/(composition|llmAdapters|retrievalSupport)\\.ts$",
        ],
      },
    },
    {
      name: "no-chat-composition-outside-app-wiring",
      severity: "error",
      comment:
        "The chat composition entrypoint is for application wiring only; other modules should use chat contracts.",
      from: {
        path: "^src/",
        pathNot: [
          "^src/modules/chat/",
          "^src/app/composition/",
          "^src/app/server/(dependencies|dependencyBuilders|types)\\.ts$",
        ],
      },
      to: {
        path: "^src/modules/chat/composition\\.ts$",
      },
    },
    {
      name: "no-llm-vendor-providers-outside-llm-infra",
      severity: "error",
      comment:
        "Vendor-specific LLM client modules (OpenAI / Gemini / Claude) are implementation details of the LLM provider registry and must not be imported by application or module code. Depend on the registry or contextual gateways instead.",
      from: {
        path: "^src/",
        pathNot: [
          "^src/shared/infra/llm/",
        ],
      },
      to: {
        path: "^src/shared/infra/llm/(openaiProvider|geminiProvider|claudeProvider)\\.ts$",
      },
    },
    {
      name: "no-capability-resolver-outside-model-layer",
      severity: "error",
      comment:
        "The LLM capability resolver interface is for the LLM-infra layer and composition wiring only. Chat / retrieval call sites depend on workspaceContext.ts for the per-call context shape; they must not reach into the resolver.",
      from: {
        path: "^src/",
        pathNot: [
          "^src/shared/infra/llm/",
          "^src/app/composition/",
          "^src/app/server/",
        ],
      },
      to: {
        path: "^src/shared/infra/llm/capabilityResolver\\.ts$",
      },
    },
    {
      name: "no-workspace-capability-resolver-impl-outside-composition",
      severity: "error",
      comment:
        "The workspace LLM capability resolver implementation is composition-only; depend on the resolver port (capabilityResolver.ts) or the registry instead.",
      from: {
        path: "^src/",
        pathNot: [
          "^src/app/composition/",
          "^src/app/server/",
        ],
      },
      to: {
        path: "^src/app/composition/workspaceLlmCapabilityResolver\\.ts$",
      },
    },
    {
      name: "no-chat-llm-adapters-outside-provider-registry",
      severity: "error",
      comment:
        "The chat LLM adapter entrypoint is only for shared LLM provider registration.",
      from: {
        path: "^src/",
        pathNot: [
          "^src/modules/chat/",
          "^src/shared/infra/llm/providerRegistry\\.ts$",
          "^src/shared/infra/llm/contextualGateways\\.ts$",
        ],
      },
      to: {
        path: "^src/modules/chat/llmAdapters\\.ts$",
      },
    },
    {
      name: "no-chat-retrieval-support-outside-retrieval-answering",
      severity: "error",
      comment:
        "The chat retrieval-support entrypoint is only for retrieval answer assembly.",
      from: {
        path: "^src/",
        pathNot: [
          "^src/modules/chat/",
          "^src/modules/retrieval/services/retrievalAnswerService\\.ts$",
        ],
      },
      to: {
        path: "^src/modules/chat/retrievalSupport\\.ts$",
      },
    },
    {
      name: "no-external-settings-internals",
      severity: "error",
      comment:
        "Production code outside settings must import settings-owned symbols through settings contracts or composition entrypoints.",
      from: {
        path: "^src/",
        pathNot: [
          "^src/modules/settings/",
        ],
      },
      to: {
        path: "^src/modules/settings/(domain|services)/",
      },
    },
    {
      name: "no-unapproved-settings-root-entrypoints",
      severity: "error",
      comment:
        "Production code outside settings may only import approved settings root entrypoints.",
      from: {
        path: "^src/",
        pathNot: [
          "^src/modules/settings/",
        ],
      },
      to: {
        path: "^src/modules/settings/[^/]+\\.ts$",
        pathNot: [
          "^src/modules/settings/composition\\.ts$",
        ],
      },
    },
    {
      name: "no-settings-composition-outside-app-wiring",
      severity: "error",
      comment:
        "The settings composition entrypoint is for application wiring only; other modules should use settings contracts.",
      from: {
        path: "^src/",
        pathNot: [
          "^src/modules/settings/",
          "^src/app/composition/",
          "^src/app/server/(dependencies|dependencyBuilders|types)\\.ts$",
        ],
      },
      to: {
        path: "^src/modules/settings/composition\\.ts$",
      },
    },
    {
      name: "no-external-audit-internals",
      severity: "error",
      comment:
        "Production code outside audit must import audit-owned symbols through audit contracts or composition entrypoints.",
      from: {
        path: "^src/",
        pathNot: [
          "^src/modules/audit/",
        ],
      },
      to: {
        path: "^src/modules/audit/services/",
      },
    },
    {
      name: "no-unapproved-audit-root-entrypoints",
      severity: "error",
      comment:
        "Production code outside audit may only import approved audit root entrypoints.",
      from: {
        path: "^src/",
        pathNot: [
          "^src/modules/audit/",
        ],
      },
      to: {
        path: "^src/modules/audit/[^/]+\\.ts$",
        pathNot: [
          "^src/modules/audit/composition\\.ts$",
        ],
      },
    },
    {
      name: "no-audit-composition-outside-app-wiring",
      severity: "error",
      comment:
        "The audit composition entrypoint is for application wiring only; other modules should use audit contracts.",
      from: {
        path: "^src/",
        pathNot: [
          "^src/modules/audit/",
          "^src/app/server/(dependencies|dependencyBuilders|types)\\.ts$",
        ],
      },
      to: {
        path: "^src/modules/audit/composition\\.ts$",
      },
    },
    {
      name: "no-connector-plugin-internals-outside-catalog",
      severity: "error",
      comment:
        "Connector plugin internals (WordPress and any future plugins) must only be imported by the built-in plugin catalog. Everything else operates through @radioso/connector-api contracts and the ConnectorRegistry.",
      from: {
        path: "^src/",
        pathNot: [
          "^src/modules/connectors/plugins/",
        ],
      },
      to: {
        path: "^src/modules/connectors/plugins/[^/]+/",
      },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
      dependencyTypes: [
        "npm",
        "npm-dev",
        "npm-optional",
        "npm-peer",
        "npm-bundled",
        "npm-no-pkg",
      ],
    },
    tsConfig: {
      fileName: "tsconfig.json",
    },
    enhancedResolveOptions: {
      extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"],
    },
  },
};
