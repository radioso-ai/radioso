import test from "node:test";
import assert from "node:assert/strict";

import { createQueueSnapshotCollector } from "../../scripts/performance/lib/collectors/queue-snapshot.mjs";

test("queue snapshot collector parses psql output into queue metrics", async () => {
  const collector = createQueueSnapshotCollector({
    databaseUrl: "postgres://example",
    spawnQuery: async () => "4|1|2026-04-14T10:00:00.000Z",
    now: () => new Date("2026-04-14T10:00:05.000Z"),
  });

  const sample = await collector.sample();

  assert.deepEqual(sample, {
    queuedJobCount: 4,
    processingJobCount: 1,
    oldestQueuedAgeMs: 5000,
  });
});

test("queue snapshot collector reports unavailable when psql is missing", async () => {
  const collector = createQueueSnapshotCollector({
    databaseUrl: "postgres://example",
    spawnQuery: async () => {
      throw new Error("spawn psql ENOENT");
    },
  });

  await assert.rejects(() => collector.sample(), /ENOENT/);
});
