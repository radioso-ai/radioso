import { describe, expect, it, vi } from "vitest";

import {
  createOperatorAuditObserver,
  createOperatorMcpFloodLimiter,
  createOperatorMcpMetrics,
} from "../src/operator/observability.js";
import { createOperatorMcpRequestHandler } from "../src/operator/requestHandler.js";

describe("operator MCP observability", () => {
  it("classifies handler outcomes without forwarding bearer or arguments to telemetry", async () => {
    const observations: unknown[] = [];
    const handler = createOperatorMcpRequestHandler({
      async admit() {
        return { proof: { accountId: "account", grantId: "grant", userId: "user", workspaceId: "workspace" } as never, requiredScope: "operator:probe" };
      },
      async call() { return { content: [{ type: "text", text: "safe" }] }; },
      async list() { return { tools: [] }; },
      onOutcome(observation) { observations.push(observation); },
    });

    await handler(new Request("https://mcp.example/operator/mcp", {
      method: "POST",
      headers: { authorization: "Bearer bearer-secret", "content-type": "application/json" },
      body: JSON.stringify({ id: "1", jsonrpc: "2.0", method: "tools/call", protocolVersion: "2026-07-28", params: {
        name: "retrieval_probe", arguments: { query: "customer content" },
      } }),
    }));

    expect(observations).toEqual([{
      method: "tools/call", outcome: "success", descriptorName: "retrieval_probe", shape: "probe",
    }]);
    expect(JSON.stringify(observations)).not.toContain("bearer-secret");
    expect(JSON.stringify(observations)).not.toContain("customer content");
  });

  it("rejects a principal flood independently after bearer admission", async () => {
    const principalRateLimit = { consume: vi.fn(() => false) };
    const handler = createOperatorMcpRequestHandler({
      async admit() {
        return { proof: { accountId: "account", grantId: "grant", userId: "user", workspaceId: "workspace" } as never };
      },
      async call() { return { content: [] }; },
      async list() { return { tools: [] }; },
      principalRateLimit,
    });

    const response = await handler(new Request("https://mcp.example/operator/mcp", {
      method: "POST",
      headers: { authorization: "Bearer bearer", "content-type": "application/json" },
      body: JSON.stringify({ id: "1", jsonrpc: "2.0", method: "ping", protocolVersion: "2026-07-28" }),
    }));

    expect(response.status).toBe(429);
    expect(principalRateLimit.consume).toHaveBeenCalledOnce();
  });

  it("emits only fixed safe audit fields and never credential or customer data", async () => {
    const events: unknown[] = [];
    const observer = createOperatorAuditObserver({
      async emit(event) { events.push(event); },
    });

    await observer({
      method: "tools/call",
      outcome: "denied",
      descriptorName: "retrieval_probe",
      shape: "probe",
      reason: "insufficient_scope",
      accessToken: "Bearer secret-token",
      arguments: { query: "customer transcript" },
      clientId: "client-secret-id",
      userId: "user-secret-id",
    });

    expect(events).toEqual([{
      eventType: "operator_mcp_method",
      metadata: {
        method: "tools/call",
        surface: "operator_mcp",
        descriptorName: "retrieval_probe",
        shape: "probe",
        reason: "insufficient_scope",
      },
      outcome: "denied",
    }]);
    expect(JSON.stringify(events)).not.toContain("secret-token");
    expect(JSON.stringify(events)).not.toContain("customer transcript");
  });

  it("keeps metric labels low-cardinality and excludes descriptor, client, user, and workspace identities", () => {
    const metrics = createOperatorMcpMetrics();
    for (const descriptorName of ["tool-a", "tool-b", "customer-content-tool"]) {
      metrics.observe({
        method: "tools/call",
        outcome: "success",
        descriptorName,
        clientId: `client-${descriptorName}`,
        userId: `user-${descriptorName}`,
        workspaceId: `workspace-${descriptorName}`,
      });
    }

    const observations = metrics.snapshot();
    expect(observations).toEqual([{ labels: { method: "tools/call", outcome: "success", surface: "operator_mcp" }, count: 3 }]);
    expect(JSON.stringify(observations)).not.toContain("tool-a");
    expect(JSON.stringify(observations)).not.toContain("client-tool");
  });

  it("bounds independent source and principal flood buckets", () => {
    const limiter = createOperatorMcpFloodLimiter({ maxAttempts: 1, windowMs: 60_000, maxSources: 2, maxPrincipals: 2 });
    expect(limiter.source.consume({ sourceDigest: "source-a" })).toBe(true);
    expect(limiter.source.consume({ sourceDigest: "source-a" })).toBe(false);
    expect(limiter.source.consume({ sourceDigest: "source-b" })).toBe(true);
    expect(limiter.source.consume({ sourceDigest: "source-c" })).toBe(false);
    expect(limiter.principal.consume({ sourceDigest: "principal-a" })).toBe(true);
    expect(limiter.principal.consume({ sourceDigest: "principal-b" })).toBe(true);
    expect(limiter.principal.consume({ sourceDigest: "principal-c" })).toBe(false);
  });
});
