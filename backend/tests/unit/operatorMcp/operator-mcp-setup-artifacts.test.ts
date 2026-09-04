import { describe, expect, it } from "vitest";

import { buildOperatorMcpSetup } from "../../../src/modules/operatorMcpSetup/setupArtifacts.js";

describe("buildOperatorMcpSetup", () => {
  it("keeps named clients unavailable until exact-build evidence exists and emits no secret", () => {
    const response = buildOperatorMcpSetup({
      enabled: true,
      resource: "https://mcp.example/operator/mcp",
      ready: true,
      now: new Date("2026-09-04T00:00:00.000Z"),
    });
    expect(response.availability).toBe("available");
    expect(response.resource).toBe("https://mcp.example/operator/mcp");
    expect(response.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "codex-cli", clientVersion: "0.149.0", status: "unavailable" }),
      expect.objectContaining({ id: "claude-code", clientVersion: "2.1.149", status: "unavailable" }),
      expect.objectContaining({ id: "chatgpt-developer-mode", status: "unavailable" }),
      expect.objectContaining({ id: "generic", status: "unverified" }),
    ]));
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
