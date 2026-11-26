import { describe, expect, it } from "vitest";

import { labelUsageOperation } from "../../src/modules/reporting/usageDetailsLabels.js";

describe("labelUsageOperation", () => {
  it("names a Test Chat model call as Test chat, apart from the live answer", () => {
    expect(labelUsageOperation({ surface: "test_execution", name: "answer" }).label).toBe("Test chat: Answer");
    expect(labelUsageOperation({ surface: "assistant", name: "answer" }).label).toBe("Answer");
  });
});
