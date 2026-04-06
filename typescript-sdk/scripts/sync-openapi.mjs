import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const packageRoot = path.resolve(new URL("..", import.meta.url).pathname);
const repoRoot = path.resolve(packageRoot, "..");
const backendJson = path.join(repoRoot, "backend", "openapi.json");
const backendYaml = path.join(repoRoot, "backend", "openapi.yaml");
const sdkOpenapiDir = path.join(packageRoot, "openapi");
const sdkJson = path.join(sdkOpenapiDir, "radioso.json");
const sdkYaml = path.join(sdkOpenapiDir, "radioso.yaml");
const generatedDir = path.join(packageRoot, "src", "generated");
const generatedTypes = path.join(generatedDir, "types.ts");

if (!existsSync(backendJson) || !existsSync(backendYaml)) {
  throw new Error("Backend OpenAPI artifacts are missing. Regenerate backend/openapi.json and backend/openapi.yaml first.");
}

mkdirSync(sdkOpenapiDir, { recursive: true });
mkdirSync(generatedDir, { recursive: true });

cpSync(backendJson, sdkJson);
cpSync(backendYaml, sdkYaml);

const generation = spawnSync(
  "npx",
  ["--no-install", "openapi-typescript", sdkJson, "-o", generatedTypes],
  {
    cwd: packageRoot,
    stdio: "inherit",
  },
);

if (generation.status !== 0) {
  throw new Error(`openapi-typescript failed with exit code ${generation.status ?? "unknown"}`);
}
