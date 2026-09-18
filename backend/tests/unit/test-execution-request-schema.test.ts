import { describe, expect, it } from "vitest";

import { startTestExecutionSchema } from "../../src/app/http/routes/agentRevisionRequestSchemas.js";

const base = {
  revisionIds: ["60000000-0000-4000-8000-000000000001"],
  testValues: [],
  idempotencyKey: "idem-1",
};
const seedConversationId = "70000000-0000-4000-8000-000000000001";

describe("startTestExecutionSchema", () => {
  it("accepts a seed conversation for a single-revision execution", () => {
    const parsed = startTestExecutionSchema.safeParse({ ...base, mode: "single", seedConversationId });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.seedConversationId).toBe(seedConversationId);
  });

  it("rejects a seed conversation on a comparison as a validation error", () => {
    const parsed = startTestExecutionSchema.safeParse({
      ...base,
      mode: "compare",
      revisionIds: [...base.revisionIds, "60000000-0000-4000-8000-000000000002"],
      seedConversationId,
    });

    expect(parsed.success).toBe(false);
    expect(parsed.success || parsed.error.issues.map((issue) => issue.path)).toEqual([["seedConversationId"]]);
  });

  it("rejects a seed conversation that is not a uuid", () => {
    expect(startTestExecutionSchema.safeParse({ ...base, mode: "single", seedConversationId: "conv-1" }).success).toBe(false);
  });
});
