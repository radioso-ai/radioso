import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("run-dev exports the Conductor frontend port as app base URL for backend emails", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "radioso-run-dev-"));
  const nodeStub = path.join(tempDir, "node");
  await fs.writeFile(
    nodeStub,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "case \"$1\" in",
      "  */scripts/sync-ee-frontend-routes.mjs)",
      "    exit 0",
      "    ;;",
      "  */scripts/bootstrap/index.mjs)",
      "    printf 'APP_BASE_URL=%s\\n' \"${APP_BASE_URL:-}\"",
      "    printf 'PUBLIC_CHAT_BASE_URL=%s\\n' \"${PUBLIC_CHAT_BASE_URL:-}\"",
      "    exit 0",
      "    ;;",
      "  *)",
      "    echo \"unexpected node target: $1\" >&2",
      "    exit 1",
      "    ;;",
      "esac",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.chmod(nodeStub, 0o755);

  try {
    const { stdout } = await execFileAsync("bash", ["run-dev.sh"], {
      cwd: path.resolve(import.meta.dirname, "../.."),
      env: {
        ...process.env,
        CONDUCTOR_PORT: "4100",
        PATH: `${tempDir}:${process.env.PATH}`,
        APP_BASE_URL: "",
        PUBLIC_CHAT_BASE_URL: "",
        RADIOSO_FRONTEND_PORT: "",
      },
    });

    assert.match(stdout, /APP_BASE_URL=http:\/\/localhost:4100/);
    assert.match(stdout, /PUBLIC_CHAT_BASE_URL=http:\/\/localhost:4100\/chat/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
