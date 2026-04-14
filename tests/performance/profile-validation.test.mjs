import test from "node:test";
import assert from "node:assert/strict";

import {
  getProfileById,
  listProfiles,
  resolveProfileExecution,
  validateProfileDefinition,
} from "../../scripts/performance/lib/profiles.mjs";

test("listProfiles exposes the expected benchmark profile families", () => {
  const profiles = listProfiles();
  const ids = profiles.map((profile) => profile.id);

  assert.deepEqual(ids, [
    "api-smoke",
    "ingestion-smoke",
    "chat-smoke",
    "mixed-smoke",
    "api-stress",
    "mixed-soak",
  ]);
});

test("validateProfileDefinition rejects guarded profiles without required collectors", () => {
  assert.throws(
    () =>
      validateProfileDefinition({
        id: "bad-profile",
        family: "mixed",
        name: "Bad",
        safetyTier: "safe",
        allowedEnvironmentClasses: ["local"],
        durationSeconds: 60,
        concurrency: 1,
        workloads: [{ kind: "document-ingest" }],
        requiredCollectors: [],
        budgets: [{ metric: "latency.p95", type: "max", threshold: 500, unit: "ms" }],
      }),
    /backlog-aware collector/i,
  );
});

test("resolveProfileExecution blocks restricted profiles unless explicitly allowed", () => {
  assert.throws(
    () =>
      resolveProfileExecution({
        profileId: "api-stress",
        environmentClass: "local",
        allowRestricted: false,
      }),
    /restricted/i,
  );
});

test("resolveProfileExecution rejects profiles in unsupported environment classes", () => {
  assert.throws(
    () =>
      resolveProfileExecution({
        profileId: "api-smoke",
        environmentClass: "pre_release",
        allowRestricted: false,
      }),
    /environment/i,
  );
});

test("getProfileById returns the profile definition for valid ids", () => {
  const profile = getProfileById("mixed-smoke");

  assert.equal(profile.family, "mixed");
  assert.ok(profile.requiredCollectors.includes("queue-snapshot"));
});
