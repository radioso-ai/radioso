import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const packageRoot = path.resolve(new URL("..", import.meta.url).pathname);
const repoRoot = path.resolve(packageRoot, "..", "..");
const backendJson = path.join(repoRoot, "backend", "openapi.json");
const generatedDir = path.join(packageRoot, "src", "generated");
const generatedTypes = path.join(generatedDir, "openapiTypes.ts");

if (!existsSync(backendJson)) {
  throw new Error("Backend OpenAPI artifact is missing. Regenerate backend/openapi.json first.");
}

mkdirSync(generatedDir, { recursive: true });

const generation = spawnSync(
  "npx",
  ["--no-install", "openapi-typescript", backendJson, "-o", generatedTypes],
  {
    cwd: packageRoot,
    stdio: "inherit",
  },
);

if (generation.status !== 0) {
  throw new Error(`openapi-typescript failed with exit code ${generation.status ?? "unknown"}`);
}
