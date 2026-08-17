import test from "node:test";
import assert from "node:assert/strict";

import {
  attachComposeStack,
  resolveReadinessTimeoutMs,
  startComposeStack,
  waitForReadiness,
} from "../../scripts/bootstrap/compose-runner.mjs";

test("resolveReadinessTimeoutMs defaults to a cold-boot-safe ceiling", () => {
  assert.equal(resolveReadinessTimeoutMs({}), 600_000);
});

test("resolveReadinessTimeoutMs honors a valid RADIOSO_STARTUP_TIMEOUT_MS override", () => {
  assert.equal(resolveReadinessTimeoutMs({ RADIOSO_STARTUP_TIMEOUT_MS: "90000" }), 90_000);
});

test("resolveReadinessTimeoutMs falls back to the default for invalid overrides", () => {
  assert.equal(resolveReadinessTimeoutMs({ RADIOSO_STARTUP_TIMEOUT_MS: "not-a-number" }), 600_000);
  assert.equal(resolveReadinessTimeoutMs({ RADIOSO_STARTUP_TIMEOUT_MS: "0" }), 600_000);
  assert.equal(resolveReadinessTimeoutMs({ RADIOSO_STARTUP_TIMEOUT_MS: "  " }), 600_000);
});

test("waitForReadiness reports progress while services are still starting", async () => {
  const ticks = [];
  let calls = 0;

  const report = await waitForReadiness({
    timeoutMs: 50,
    intervalMs: 1,
    onProgress: (tick) => ticks.push(tick),
    checks: [
      {
        name: "backend",
        probe: async () => {
          calls += 1;
          return calls > 2;
        },
      },
    ],
  });

  assert.equal(report.ok, true);
  assert.ok(ticks.length >= 1);
  assert.ok(ticks.every((tick) => tick.timeoutMs === 50 && typeof tick.elapsedMs === "number"));
});

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

test("waitForReadiness reports URLs from configured local ports", async () => {
  const report = await waitForReadiness({
    timeoutMs: 50,
    intervalMs: 1,
    ports: {
      frontend: 4100,
      backend: 4101,
      postgres: 4102,
    },
    checks: [
      { name: "frontend", probe: async () => true },
      { name: "backend", probe: async () => true },
    ],
  });

  assert.deepEqual(report.applicationUrls, ["http://127.0.0.1:4100", "http://127.0.0.1:4101"]);
});

test("waitForReadiness probes configured local ports by default", async () => {
  const fetchedUrls = [];
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (url) => {
      fetchedUrls.push(url);
      return { ok: true };
    };

    await waitForReadiness({
      timeoutMs: 50,
      intervalMs: 1,
      ports: {
        frontend: 4200,
        backend: 4201,
        postgres: 4202,
      },
    });

    assert.deepEqual(fetchedUrls, ["http://127.0.0.1:4200", "http://127.0.0.1:4201/health"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("attachComposeStack runs compose without detached mode", async () => {
  let receivedArgs = null;
  const result = await attachComposeStack({
    spawn: async (_command, args) => {
      receivedArgs = args;
      return { code: 0, signal: null };
    },
  });

  assert.equal(result.code, 0);
  assert.ok(receivedArgs.includes("up"));
  assert.ok(receivedArgs.includes("--build"));
  assert.ok(!receivedArgs.includes("-d"));
});
