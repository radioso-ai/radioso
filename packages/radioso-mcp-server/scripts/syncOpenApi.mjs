#!/usr/bin/env node

/**
 * Generate the MCP package's typed view of the backend OpenAPI document.
 *
 * Run `pnpm run sync:openapi` after the backend contract changes. CI can run
 * `pnpm run check:openapi` to verify that the checked-in generated file is
 * deterministic and has not drifted from `backend/openapi.json`.
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import openapiTS, { astToString } from "openapi-typescript";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const sourcePath = path.join(repositoryRoot, "backend", "openapi.json");
const outputPath = path.join(packageRoot, "src", "generated", "openapiTypes.ts");

const generated = astToString(await openapiTS(JSON.parse(await readFile(sourcePath, "utf8"))));

if (process.argv.includes("--check")) {
  let current;
  try {
    current = await readFile(outputPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      console.error(`Missing generated OpenAPI types: ${path.relative(repositoryRoot, outputPath)}`);
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
  if (current !== undefined && current !== generated) {
    console.error(`Generated OpenAPI types are stale: ${path.relative(repositoryRoot, outputPath)}`);
    process.exitCode = 1;
  }
  if (process.exitCode !== 1) console.log("MCP OpenAPI types are current.");
} else {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, generated, "utf8");
  console.log(`Wrote ${path.relative(repositoryRoot, outputPath)}`);
}
