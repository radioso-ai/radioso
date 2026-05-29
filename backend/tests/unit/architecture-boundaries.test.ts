import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const moduleUrl = new URL("../../../scripts/validate-architecture-boundaries.mjs", import.meta.url);
const {
  validateImportRecords,
  validateRepositoryBoundaries,
} = await import(moduleUrl.href) as any;

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

  it("allows approved public contract imports", () => {
    const result = validateImportRecords([
      {
        filePath: "backend/src/modules/chat/services/example.ts",
        specifier: "../../documents/contracts/index.js",
      },
      {
        filePath: "backend/src/modules/documents/services/example.ts",
        specifier: "../../chat/contracts/index.js",
      },
    ]);

    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("rejects representative private cross-module backend imports", () => {
    const result = validateImportRecords([
      {
        filePath: "backend/src/modules/chat/services/example.ts",
        specifier: "../../documents/services/documentIngestionService.js",
      },
    ]);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
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

  it("validates the current repository without forbidden boundary imports", async () => {
    const result = await validateRepositoryBoundaries(new URL("../../..", import.meta.url).pathname);

    expect(result).toEqual({ valid: true, errors: [] });
  }, 15_000);

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
});
