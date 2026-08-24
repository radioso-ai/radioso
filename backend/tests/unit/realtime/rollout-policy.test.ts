import { describe, expect, it } from "vitest";
import { createRealtimeRolloutPolicy } from "../../../src/modules/realtime/domain/realtimeRolloutPolicy.js";

const accountId = "4d7293c8-d241-4f8f-a4db-3df5b88da44c";

describe("realtime rollout policy", () => {
  it("handles disabled, internal, allowlist, and default-on synchronously", () => {
    expect(createRealtimeRolloutPolicy({ mode: "disabled", accountIds: [] }).allows({ accountId })).toBe(false);
    expect(createRealtimeRolloutPolicy({ mode: "internal", accountIds: [], internalAccountIds: [accountId] }).allows({ accountId })).toBe(true);
    expect(createRealtimeRolloutPolicy({ mode: "allowlist", accountIds: [accountId] }).allows({ accountId })).toBe(true);
    expect(createRealtimeRolloutPolicy({ mode: "default-on", accountIds: [] }).allows({ accountId })).toBe(true);
  });
});
