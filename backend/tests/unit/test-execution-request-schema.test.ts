import { describe, expect, it } from "vitest";

import {
  retryTestExecutionSideSchema,
  sendTestExecutionMessageSchema,
  startTestExecutionSchema,
} from "../../src/app/http/routes/agentRevisionRequestSchemas.js";

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

describe("test execution turn requests", () => {
  const turn = {
    executionGeneration: 1,
    turnId: "80000000-0000-4000-8000-000000000001",
    attemptId: "80000000-0000-4000-8000-000000000002",
  };

  it("takes the operator's browser time zone with a message, optionally", () => {
    const withZone = sendTestExecutionMessageSchema.safeParse({ ...turn, message: "What's on tomorrow?", userTimeZone: " America/Los_Angeles " });
    const withoutZone = sendTestExecutionMessageSchema.safeParse({ ...turn, message: "What's on tomorrow?" });

    expect(withZone.success && withZone.data.userTimeZone).toBe("America/Los_Angeles");
    expect(withoutZone.success && withoutZone.data.userTimeZone).toBeUndefined();
  });

  it("takes the browser time zone with a retry of a failed side", () => {
    const parsed = retryTestExecutionSideSchema.safeParse({ ...turn, userTimeZone: "Europe/Rome" });

    expect(parsed.success && parsed.data.userTimeZone).toBe("Europe/Rome");
  });

  it("rejects a time zone name longer than any IANA name", () => {
    expect(sendTestExecutionMessageSchema.safeParse({ ...turn, message: "Hi", userTimeZone: "A".repeat(65) }).success).toBe(false);
  });
});
