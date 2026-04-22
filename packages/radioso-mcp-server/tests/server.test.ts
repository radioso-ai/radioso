import { describe, expect, it, vi } from "vitest";

import { createRadiosoMcpServer } from "../src/server.js";

describe("createRadiosoMcpServer", () => {
  it("exposes all read and write tool definitions", () => {
    const resolveExecutionContext = vi.fn();
    const server = createRadiosoMcpServer({
      resolveExecutionContext,
      serverName: "radioso-test",
    });

    expect(server.toolDefinitions).toHaveLength(11);
    expect(server.toolDefinitions.map((tool) => tool.name)).toContain("answer_grounded");
    expect(server.toolDefinitions.map((tool) => tool.name)).toContain("update_retrieval_settings");
  });

  it("filters tool registration to the allowed session catalog", () => {
    const server = createRadiosoMcpServer({
      allowedTools: ["describe_capabilities", "list_documents"],
      resolveExecutionContext: vi.fn(),
      serverName: "radioso-test",
    });

    expect(server.toolDefinitions.map((tool) => tool.name)).toEqual([
      "describe_capabilities",
      "list_documents",
    ]);
  });

  it("refuses to boot without an execution-context seam", () => {
    expect(() =>
      createRadiosoMcpServer({
        serverName: "radioso-test",
      }),
    ).toThrow(/baseConfig or resolveExecutionContext/i);
  });
});
