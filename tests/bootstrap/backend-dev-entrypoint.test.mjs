import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(new URL("../..", import.meta.url).pathname);

test("backend dev entrypoint serializes shared dependency installs", async () => {
  const entrypoint = await readFile(path.join(repoRoot, "infra/backend.dev.entrypoint.sh"), "utf8");

  assert.match(entrypoint, /INSTALL_STATE_FILE="node_modules\/\.backend-install-state"/);
  assert.match(entrypoint, /INSTALL_LOCK_DIR="node_modules\/\.backend-install\.lock"/);
  assert.match(entrypoint, /acquire_install_lock\(\) \{/);
  assert.match(entrypoint, /Waiting for another backend dependency install to finish/);
  assert.match(entrypoint, /backend_modules_ready \|\| return 1/);
  assert.match(entrypoint, /refresh_saved_install_state/);
});
