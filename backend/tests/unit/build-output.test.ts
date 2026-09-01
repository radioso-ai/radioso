import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { cleanBuildOutput } from "../../scripts/cleanBuildOutput.mjs";

describe("backend build output", () => {
  it("removes stale compiled migrations before a production build", async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "radioso-build-output-"));
    const distRoot = path.join(temporaryRoot, "dist");

    try {
      await mkdir(path.join(distRoot, "src", "db", "migrations"), { recursive: true });
      await writeFile(path.join(distRoot, "src", "db", "migrations", "obsolete.sql"), "stale");
      await writeFile(path.join(distRoot, "src", "stale.js"), "stale");

      await cleanBuildOutput(distRoot);

      await expect(readdir(distRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
