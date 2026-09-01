import { describe, expect, it } from "vitest";

import { getMcpStatus } from "../../src/app/server/mcpStatus.js";

describe("MCP status", () => {
  it("advertises a configured standalone MCP endpoint", () => {
    expect(getMcpStatus({
      RADIOSO_MCP_ENABLED: true,
      RADIOSO_MCP_MOUNT_PATH: "/mcp",
      RADIOSO_MCP_STANDALONE: true,
    })).toEqual({
      enabled: true,
      mode: "standalone",
      path: "/mcp",
      ready: true,
      standalone: true,
    });
  });

  it("does not advertise MCP when standalone mode is disabled", () => {
    expect(getMcpStatus({
      RADIOSO_MCP_ENABLED: true,
      RADIOSO_MCP_MOUNT_PATH: "/mcp",
      RADIOSO_MCP_STANDALONE: false,
    })).toMatchObject({
      enabled: false,
      mode: "disabled",
      standalone: false,
    });
  });
});
