import { describe, expect, it, vi } from "vitest";

import { createRadiosoMcpServer } from "../src/server.js";

describe("createRadiosoMcpServer", () => {
  it("exposes the agent conversation tool and the Radioso documentation tools", () => {
    const server = createRadiosoMcpServer({
      resolveExecutionContext: vi.fn(),
      serverName: "radioso-test",
    });

    expect(server.toolDefinitions.map((tool) => tool.name)).toEqual([
      "ask_agent",
      "radioso_docs",
      "radioso_doc_page",
    ]);
  });

  it("requires an execution-context resolver", () => {
    expect(() => createRadiosoMcpServer({ serverName: "radioso-test" }))
      .toThrow(/execution-context resolver/i);
  });
});
