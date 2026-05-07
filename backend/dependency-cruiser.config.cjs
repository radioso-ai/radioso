module.exports = {
  forbidden: [
    {
      name: "no-external-retrieval-internals",
      severity: "error",
      comment:
        "Production code outside retrieval must import retrieval-owned symbols through explicit retrieval public entrypoints.",
      from: {
        path: "^src/",
        pathNot: [
          "^src/modules/retrieval/",
        ],
      },
      to: {
        path: "^src/modules/retrieval/(domain|services|infra)/",
      },
    },
    {
      name: "no-unapproved-retrieval-root-entrypoints",
      severity: "error",
      comment:
        "Production code outside retrieval may only import approved retrieval root entrypoints.",
      from: {
        path: "^src/",
        pathNot: [
          "^src/modules/retrieval/",
        ],
      },
      to: {
        path: "^src/modules/retrieval/[^/]+\\.ts$",
        pathNot: [
          "^src/modules/retrieval/(public|composition|llmAdapters)\\.ts$",
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
          "^src/app/server/(dependencies|types)\\.ts$",
          "^src/app/composition/defaultComposition\\.ts$",
        ],
      },
      to: {
        path: "^src/modules/retrieval/composition\\.ts$",
      },
    },
    {
      name: "no-retrieval-llm-adapters-outside-provider-registry",
      severity: "error",
      comment:
        "The retrieval LLM adapter entrypoint is only for shared LLM provider registration.",
      from: {
        path: "^src/",
        pathNot: [
          "^src/modules/retrieval/",
          "^src/shared/infra/llm/providerRegistry\\.ts$",
        ],
      },
      to: {
        path: "^src/modules/retrieval/llmAdapters\\.ts$",
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
