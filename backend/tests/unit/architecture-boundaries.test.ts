import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const moduleUrl = new URL("../../../scripts/validate-architecture-boundaries.mjs", import.meta.url);
const {
  validateImportRecords,
  validateRepositoryBoundaries,
} = await import(moduleUrl.href);
const require = createRequire(import.meta.url);
const dependencyCruiserConfig = require("../../dependency-cruiser.config.cjs") as {
  forbidden: Array<{
    name: string;
    to: { pathNot?: string[] };
  }>;
  options: Record<string, unknown>;
};

let tempRoot: string | null = null;

afterEach(async () => {
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

describe("architecture boundary validation", () => {
  it("rejects OSS imports from Enterprise implementation paths", () => {
    const result = validateImportRecords([
      {
        filePath: "backend/src/modules/documents/services/example.ts",
        specifier: "../../../ee/packages/backend-module/src/index.js",
      },
      {
        filePath: "frontend/components/example.tsx",
        specifier: "@radioso/enterprise-sample-frontend/sample-page",
      },
      {
        filePath: "packages/radioso-mcp-server/src/server.ts",
        specifier: "../../ee/packages/backend-module/src/index.js",
      },
    ]);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      expect.stringContaining("OSS source must not import Enterprise code"),
      expect.stringContaining("OSS source must not import Enterprise code"),
      expect.stringContaining("OSS source must not import Enterprise code"),
    ]);
  });

  it("allows approved public entrypoint and contract imports", () => {
    const result = validateImportRecords([
      {
        filePath: "backend/src/modules/chat/services/example.ts",
        specifier: "../../documents/public.js",
      },
      {
        filePath: "backend/src/modules/chat/services/example.ts",
        specifier: "../../documents/contracts/index.js",
      },
      {
        filePath: "backend/src/modules/documents/services/example.ts",
        specifier: "../../chat/contracts/index.js",
      },
      {
        filePath: "backend/src/modules/auth/services/example.ts",
        specifier: "../../mail/templates/passwordResetEmail.js",
      },
      {
        filePath: "backend/src/modules/retrieval/services/example.ts",
        specifier: "../../chat/retrievalSupport.js",
      },
    ]);

    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("keeps dependency-cruiser support entrypoints aligned with the validator", () => {
    const rule = dependencyCruiserConfig.forbidden.find(
      ({ name }) => name === "no-cross-module-internals",
    );

    expect(rule?.to.pathNot).toEqual([
      "^src/modules/$1/",
      "^src/modules/[^/]+/public\\.ts$",
      "^src/modules/chat/retrievalSupport\\.ts$",
      "^src/modules/documents/historySupport\\.ts$",
      "^src/modules/[^/]+/(contracts|templates)/",
    ]);
  });

  it("rejects cross-module composition imports outside application wiring", () => {
    const result = validateImportRecords([
      {
        filePath: "backend/src/modules/chat/services/example.ts",
        specifier: "../../documents/composition.js",
      },
    ]);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      expect.stringContaining(
        "Backend module composition entrypoints are for application wiring only",
      ),
    ]);
  });

  it("rejects private cross-module imports regardless of their path shape", () => {
    const result = validateImportRecords([
      {
        filePath: "backend/src/modules/chat/services/example.ts",
        specifier: "../../documents/services/documentIngestionService.js",
      },
      {
        filePath: "backend/src/modules/chat/services/example.ts",
        specifier: "../../documents/repository.js",
      },
      {
        filePath: "backend/src/modules/chat/services/example.ts",
        specifier: "../../documents/domain.js",
      },
      {
        filePath: "backend/src/modules/chat/services/example.ts",
        specifier: "../../documents/services/public.js",
      },
      {
        filePath: "backend/src/modules/chat/services/example.ts",
        specifier: "../../documents/services/contracts/private.js",
      },
      {
        filePath: "backend/src/modules/chat/services/example.ts",
        specifier: "../../documents/retrievalSupport.js",
      },
    ]);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      expect.stringContaining("Backend modules must use public contracts for cross-module imports"),
      expect.stringContaining("Backend modules must use public contracts for cross-module imports"),
      expect.stringContaining("Backend modules must use public contracts for cross-module imports"),
      expect.stringContaining("Backend modules must use public contracts for cross-module imports"),
      expect.stringContaining("Backend modules must use public contracts for cross-module imports"),
      expect.stringContaining("Backend modules must use public contracts for cross-module imports"),
    ]);
  });

  it("rejects conversation contract imports from Radioso product implementation paths", () => {
    const result = validateImportRecords([
      {
        filePath: "packages/conversation-contract/index.d.ts",
        specifier: "../../backend/src/modules/retrieval/public.js",
      },
      {
        filePath: "packages/conversation-contract/index.d.ts",
        specifier: "@radioso/mcp-server",
      },
    ]);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      expect.stringContaining("Conversation contract must not import Radioso product implementation code"),
      expect.stringContaining("Conversation contract must not import Radioso product implementation code"),
    ]);
  });

  it("rejects conversation engine imports from Radioso product implementation paths", () => {
    const result = validateImportRecords([
      {
        filePath: "packages/conversation-engine/src/index.ts",
        specifier: "../../../backend/src/modules/retrieval/public.js",
      },
      {
        filePath: "packages/conversation-engine/src/index.ts",
        specifier: "@radioso/mcp-server",
      },
      {
        filePath: "packages/conversation-engine/src/index.ts",
        specifier: "@radioso/conversation-contract",
      },
    ]);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      expect.stringContaining("Conversation engine must not import Radioso product implementation code"),
      expect.stringContaining("Conversation engine must not import Radioso product implementation code"),
    ]);
  });

  it("rejects standalone MCP server imports from backend implementation paths", () => {
    const result = validateImportRecords([
      {
        filePath: "packages/radioso-mcp-server/src/server.ts",
        specifier: "../../../backend/src/modules/settings/domain/publicChatSession.js",
      },
      {
        filePath: "packages/radioso-mcp-server/src/tools/converseTools.ts",
        specifier: "../../../../backend/src/modules/chat/services/agentConverseService.js",
      },
    ]);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      expect.stringContaining("Radioso MCP server must call backend over HTTP instead of importing backend code"),
      expect.stringContaining("Radioso MCP server must call backend over HTTP instead of importing backend code"),
    ]);
  });

  it("validates the current repository without forbidden boundary imports", async () => {
    const result = await validateRepositoryBoundaries(new URL("../../..", import.meta.url).pathname);

    expect(result).toEqual({ valid: true, errors: [] });
  }, 60_000);

  it("detects protected private imports when scanning repository files", async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "radioso-boundaries-"));
    const sourceFile = path.join(tempRoot, "backend/src/modules/chat/services/example.ts");
    await fs.mkdir(path.dirname(sourceFile), { recursive: true });
    await fs.writeFile(
      sourceFile,
      [
        "import { DocumentIngestionService } from '../../documents/services/documentIngestionService.js';",
        "",
        "export const value = DocumentIngestionService;",
        "",
      ].join("\n"),
    );

    const result = await validateRepositoryBoundaries(tempRoot);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      expect.stringContaining("Backend modules must use public contracts for cross-module imports"),
    ]);
  });

  // Type-only imports are erased at compile time, so dependency-cruiser cannot see them unless
  // `tsPreCompilationDeps` is on. Ray is the case that matters most — a type is the tempting thing
  // to borrow from it — so this cruises a fixture with the committed rule set rather than asserting
  // the flag's value, which would pass just as happily with the rule deleted.
  it("catches a type-only import from a domain module into the operator copilot", async () => {
    const { cruise } = await import("dependency-cruiser");
    tempRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "radioso-depcruise-")));
    await fs.mkdir(path.join(tempRoot, "src/modules/agents"), { recursive: true });
    await fs.mkdir(path.join(tempRoot, "src/modules/operatorCopilot"), { recursive: true });
    await fs.writeFile(
      path.join(tempRoot, "src/modules/operatorCopilot/public.ts"),
      "export interface CopilotToolShape { name: string }\n",
    );
    await fs.writeFile(
      path.join(tempRoot, "src/modules/agents/borrow.ts"),
      [
        'import type { CopilotToolShape } from "../operatorCopilot/public.js";',
        "",
        "export const label = (shape: CopilotToolShape): string => shape.name;",
        "",
      ].join("\n"),
    );

    const result = await cruise(["src"], {
      ...dependencyCruiserConfig.options,
      baseDir: tempRoot,
      tsConfig: undefined,
      validate: true,
      ruleSet: { forbidden: dependencyCruiserConfig.forbidden },
    } as never);

    const violations = (result.output as { summary: { violations: Array<{ rule: { name: string } }> } })
      .summary.violations;
    expect(violations.map((violation) => violation.rule.name)).toContain(
      "no-domain-module-imports-operator-copilot",
    );
  }, 30_000);

  // Ray-specific vocabulary in chat is a boundary break that no import rule can see: the knowledge
  // leaks without an import. Previously enforced by scripts/checkCopilotBoundary.mjs, whose import
  // half the rule above now covers.
  it("keeps operator-copilot knowledge out of the chat module", async () => {
    const chatDir = new URL("../../src/modules/chat/", import.meta.url).pathname;
    const rayKnowledge = /\b(?:AgentTurnTest|OPERATOR_COPILOT_PROBE_SOURCE_CHANNEL|copilotConversationId|operatorUserId|probeUserMessageId)\b/;

    const walk = async (dir: string): Promise<string[]> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const nested = await Promise.all(entries.map(async (entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [full] : [];
      }));
      return nested.flat();
    };

    const offenders: string[] = [];
    for (const file of await walk(chatDir)) {
      if (rayKnowledge.test(await fs.readFile(file, "utf8"))) offenders.push(path.relative(chatDir, file));
    }

    expect(offenders).toEqual([]);
  }, 30_000);
});
