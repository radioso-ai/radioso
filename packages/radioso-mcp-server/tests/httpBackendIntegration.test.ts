import { describe, expect, it } from "vitest";

import { runSingleNodeSmoke } from "../testing/remoteSmokeHarness.js";

describe("remote MCP backend integration", () => {
  it(
    "completes a real read/write flow against the in-memory backend app",
    async () => {
      const summary = await runSingleNodeSmoke({
        step: () => {},
      });

      expect(summary.documentId).toMatch(/[0-9a-f-]{36}/i);
      expect(summary.answer.toLowerCase()).toContain("remote context writes and reads work end to end");
    },
    30_000,
  );
});
