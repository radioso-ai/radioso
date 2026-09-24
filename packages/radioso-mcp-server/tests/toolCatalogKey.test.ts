import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { toToolCatalogKey } from "../src/auth/toolCatalogKey.js";
import type { AgentToolDescriptor } from "../src/converseApiAdapter.js";

const startReturn: AgentToolDescriptor = {
  toolName: "start_return",
  description: "Start a return for an order.",
  routineLineageId: "lineage-return",
  inputSchema: {
    type: "object",
    properties: { orderId: { type: "string" } },
    required: ["orderId"],
    additionalProperties: false,
  },
};

describe("toToolCatalogKey", () => {
  it("is the full SHA-256 hex digest of the descriptor list", () => {
    const key = toToolCatalogKey([startReturn]);

    expect(key).toMatch(/^[0-9a-f]{64}$/u);
    expect(key).toBe(createHash("sha256").update(JSON.stringify([[startReturn], null])).digest("hex"));
  });

  it("changes with anything a client can observe about the tools, and with their order", () => {
    const other: AgentToolDescriptor = { ...startReturn, toolName: "request_callback" };

    expect(toToolCatalogKey([startReturn])).not.toBe(toToolCatalogKey([{ ...startReturn, description: "Start a return." }]));
    expect(toToolCatalogKey([startReturn, other])).not.toBe(toToolCatalogKey([other, startReturn]));
    expect(toToolCatalogKey([])).toBe(toToolCatalogKey([]));
  });

  it("separates two agents that expose no routines but describe themselves differently", () => {
    // Sessions whose keys match share one MCP server. Every agent without an exposed routine hashes
    // to the same empty tool list, so without the description in the key the second agent to
    // connect would be served the first agent's `ask_agent` description.
    expect(toToolCatalogKey([], "Hold a conversation with Acme Support."))
      .not.toBe(toToolCatalogKey([], "Hold a conversation with Globex Billing."));
    expect(toToolCatalogKey([], "Hold a conversation with Acme Support."))
      .toBe(toToolCatalogKey([], "Hold a conversation with Acme Support."));
    // An older backend composes nothing; that is its own key, not any agent's.
    expect(toToolCatalogKey([])).not.toBe(toToolCatalogKey([], "Hold a conversation with Acme Support."));
  });
});
