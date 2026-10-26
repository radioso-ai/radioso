#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);

const files = {
  backendJson: path.join(repoRoot, "backend", "openapi.json"),
  backendYaml: path.join(repoRoot, "backend", "openapi.yaml"),
  sdkJson: path.join(repoRoot, "typescript-sdk", "openapi", "radioso.json"),
  sdkYaml: path.join(repoRoot, "typescript-sdk", "openapi", "radioso.yaml"),
  sdkTypes: path.join(repoRoot, "typescript-sdk", "src", "generated", "types.ts"),
};

const errors = [];

const read = (filePath) => readFileSync(filePath, "utf8");

const expectSame = (actualPath, expectedPath, label) => {
  if (read(actualPath) !== read(expectedPath)) {
    errors.push(`${label} is stale. Run the owning package sync command and commit the result.`);
  }
};

const generateTypes = ({ cwd, source, output }) => {
  const result = spawnSync(
    "pnpm",
    ["--dir", path.join(repoRoot, "backend"), "exec", "openapi-typescript", source, "-o", output],
    {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    },
  );

  if (result.status !== 0) {
    errors.push([
      `Could not generate OpenAPI types in ${cwd}.`,
      result.stderr.trim() || result.stdout.trim() || `exit code ${result.status ?? "unknown"}`,
    ].join(" "));
  }
};

// The MCP server keeps its own typed view of the backend contract
// (packages/radioso-mcp-server/src/generated/openapiTypes.ts), generated from the same
// backend/openapi.json this script already checks above. Its own `check:openapi` script
// regenerates it in memory and compares against the committed file, so it is the one place that
// knows how to tell "current" from "stale" for that package.
const checkMcpServerOpenApiTypes = () => {
  const result = spawnSync("pnpm", ["run", "check:openapi"], {
    cwd: path.join(repoRoot, "packages", "radioso-mcp-server"),
    encoding: "utf8",
    stdio: "pipe",
  });

  if (result.status !== 0) {
    errors.push([
      "packages/radioso-mcp-server/src/generated/openapiTypes.ts is stale.",
      "Run `cd packages/radioso-mcp-server && pnpm run sync:openapi` and commit the result.",
      (result.stderr || result.stdout || "").trim(),
    ].filter(Boolean).join(" "));
  }
};

expectSame(files.backendJson, files.sdkJson, "typescript-sdk/openapi/radioso.json");
expectSame(files.backendYaml, files.sdkYaml, "typescript-sdk/openapi/radioso.yaml");
checkMcpServerOpenApiTypes();

const tempDir = mkdtempSync(path.join(os.tmpdir(), "radioso-api-contracts-"));
try {
  const expectedSdkTypes = path.join(tempDir, "sdk-types.ts");
  generateTypes({
    cwd: path.join(repoRoot, "typescript-sdk"),
    source: files.sdkJson,
    output: expectedSdkTypes,
  });

  if (errors.length === 0) {
    expectSame(expectedSdkTypes, files.sdkTypes, "typescript-sdk/src/generated/types.ts");
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

if (errors.length > 0) {
  process.stderr.write(`API contract drift detected:\n${errors.map((error) => `- ${error}`).join("\n")}\n`);
  process.exit(1);
}

process.stdout.write("API contract artifacts are current.\n");
