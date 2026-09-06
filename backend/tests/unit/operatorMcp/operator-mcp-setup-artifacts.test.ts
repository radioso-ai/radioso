import { describe, expect, it } from "vitest";

import { buildOperatorMcpSetup } from "../../../src/modules/operatorMcpSetup/setupArtifacts.js";

describe("buildOperatorMcpSetup", () => {
  it("returns short, credential-free setup snippets for the supported client choices", () => {
    const response = buildOperatorMcpSetup({
      enabled: true,
      resource: "https://mcp.example/operator/mcp",
      ready: true,
      now: new Date("2026-09-04T00:00:00.000Z"),
    });
    expect(response.availability).toBe("available");
    expect(response.resource).toBe("https://mcp.example/operator/mcp");
    expect(response.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "codex-cli",
        status: "unverified",
        command: "codex mcp add radioso --url https://mcp.example/operator/mcp && codex mcp login radioso",
      }),
      expect.objectContaining({
        id: "claude-code",
        status: "unverified",
        command: "claude mcp add --transport http radioso https://mcp.example/operator/mcp",
      }),
      expect.objectContaining({
        id: "cursor",
        status: "unverified",
        configuration: expect.stringContaining('"url": "https://mcp.example/operator/mcp"'),
      }),
      expect.objectContaining({ id: "generic", displayName: "Other", status: "unverified" }),
    ]));
    expect(response.artifacts).toHaveLength(4);
    expect(JSON.stringify(response)).not.toMatch(/(?:token|secret|password)\s*[:=]\s*[A-Za-z0-9_-]{8,}/iu);
  });

  it("returns no launch artifact when the deployment is disabled or misconfigured", () => {
    expect(buildOperatorMcpSetup({ enabled: false, resource: undefined, ready: false, now: new Date() })).toMatchObject({
      availability: "disabled", resource: null, artifacts: [],
    });
    expect(buildOperatorMcpSetup({ enabled: true, resource: undefined, ready: false, now: new Date() })).toMatchObject({
      availability: "misconfigured", resource: null, artifacts: [],
    });
    expect(buildOperatorMcpSetup({ enabled: true, resource: "https://mcp.example/operator/mcp", ready: false, now: new Date() })).toMatchObject({
      availability: "unavailable", resource: null, artifacts: [],
    });
  });
});
