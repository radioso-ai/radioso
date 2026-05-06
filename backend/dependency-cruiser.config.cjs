module.exports = {
  forbidden: [
    {
      name: "no-external-retrieval-internals",
      severity: "error",
      comment:
        "Production code outside retrieval must import retrieval-owned symbols through src/modules/retrieval/public.ts.",
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
