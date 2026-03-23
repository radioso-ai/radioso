import test from "node:test";
import assert from "node:assert/strict";

import { startComposeStack, waitForReadiness } from "../../scripts/bootstrap/compose-runner.mjs";

test("startComposeStack returns failure when compose up exits non-zero", async () => {
  const report = await startComposeStack({
    spawn: async () => 1,
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.failedServices, ["compose"]);
});

test("waitForReadiness succeeds when all probes pass", async () => {
  const report = await waitForReadiness({
    timeoutMs: 50,
    intervalMs: 1,
    checks: [
      { name: "frontend", probe: async () => true },
      { name: "backend", probe: async () => true },
    ],
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.readyServices, ["frontend", "backend"]);
});
