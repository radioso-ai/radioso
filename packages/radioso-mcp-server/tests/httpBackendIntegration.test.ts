import { describe, expect, it } from "vitest";

import { runConverseGrantSmoke } from "../testing/remoteSmokeHarness.js";

describe("remote MCP backend integration", () => {
  it(
    "accepts an MCP converse grant bearer and exposes only the converse surface",
    async () => {
      const summary = await runConverseGrantSmoke({
        step: () => {},
      });

      expect(summary.agentId).toMatch(/[0-9a-f-]{36}/i);
      expect(summary.answer.length).toBeGreaterThan(0);
    },
    30_000,
  );
});
