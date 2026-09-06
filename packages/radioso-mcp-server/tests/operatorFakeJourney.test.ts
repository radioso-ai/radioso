import { describe, expect, it } from "vitest";
import { runFakeOperatorJourney } from "./fixtures/operator-mcp-fakeJourney.js";

describe("operator MCP fake authorization/resource journey", () => {
  it("completes OAuth discovery, callback, stateless calls, refresh, and revocation", async () => {
    await expect(runFakeOperatorJourney()).resolves.toEqual({ status: "revoked" });
  });
});

