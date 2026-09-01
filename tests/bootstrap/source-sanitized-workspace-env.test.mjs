import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "../..");
const helperPath = path.join(repoRoot, "scripts/bootstrap/source-sanitized-workspace-env.sh");

test("common-db environment preparation removes a stale integration URL before sourcing child environment", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "radioso-common-db-env-"));
  await fs.writeFile(
    path.join(tempDir, ".env"),
    [
      "CUSTOM_DEPLOYMENT_SETTING=preserve-me",
      "INTEGRATION_DATABASE_URL=postgres://postgres:postgres@localhost:5432/radioso_test",
      "DATABASE_URL=\"$INTEGRATION_DATABASE_URL\"",
      "",
    ].join("\n"),
    "utf8",
  );

  try {
    const { stdout } = await execFileAsync(
      "bash",
      [
        "-c",
        "set -euo pipefail; source \"$1\"; source_sanitized_workspace_env \"$2\"; node -e 'console.log(JSON.stringify({ integration: process.env.INTEGRATION_DATABASE_URL, database: process.env.DATABASE_URL, custom: process.env.CUSTOM_DEPLOYMENT_SETTING }))'",
        "bash",
        helperPath,
        tempDir,
      ],
      {
        env: {
          ...process.env,
          INTEGRATION_DATABASE_URL: "postgres://postgres:postgres@localhost:5432/inherited_unsafe_test",
        },
      },
    );
    const childEnvironment = JSON.parse(stdout.trim().split("\n").at(-1));

    assert.deepEqual(childEnvironment, { database: "", custom: "preserve-me" });
    assert.doesNotMatch(await fs.readFile(path.join(tempDir, ".env"), "utf8"), /INTEGRATION_DATABASE_URL=/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
