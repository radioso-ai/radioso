import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadEnvFileIfPresent } from "../../src/runtime/loadEnv.js";

describe("runtime env loading", () => {
  const originalCwd = process.cwd();
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    while (tempDirs.length > 0) {
      await rm(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("loads the repository root env file when started from the backend directory", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "radioso-env-root-"));
    tempDirs.push(repoRoot);
    const backendDir = path.join(repoRoot, "backend");
    await mkdir(backendDir);
    await writeFile(path.join(repoRoot, ".env"), "PORT=8080\n", "utf8");
    process.chdir(backendDir);

    const loadEnvFile = vi.spyOn(process, "loadEnvFile").mockImplementation(() => {});

    loadEnvFileIfPresent();

    expect(loadEnvFile).toHaveBeenCalledWith("../.env");
  });

  it("prefers an env file in the current working directory when one exists", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "radioso-env-local-"));
    tempDirs.push(repoRoot);
    const backendDir = path.join(repoRoot, "backend");
    await mkdir(backendDir);
    await writeFile(path.join(repoRoot, ".env"), "PORT=8080\n", "utf8");
    await writeFile(path.join(backendDir, ".env"), "PORT=8081\n", "utf8");
    process.chdir(backendDir);

    const loadEnvFile = vi.spyOn(process, "loadEnvFile").mockImplementation(() => {});

    loadEnvFileIfPresent();

    expect(loadEnvFile).toHaveBeenCalledWith(".env");
  });
});
