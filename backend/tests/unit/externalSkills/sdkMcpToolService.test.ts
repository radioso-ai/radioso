import { describe, expect, it } from "vitest";

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { McpCredentialsRejectedError, McpServerUnavailableError } from "../../../src/modules/externalSkills/domain.js";
import { SdkMcpToolService } from "../../../src/modules/externalSkills/toolService/sdkMcpToolService.js";

const jsonRpcErrorResponse = (status: number, message: string): Response =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });

/** A transport whose `start()` never resolves — simulates a hung server. */
const hangingTransport = (): Transport => ({
  start: () => new Promise<void>(() => undefined),
  send: async () => undefined,
  close: async () => undefined,
});

describe("SdkMcpToolService discovery failures", () => {
  it.each([401, 403])("reports a %i from the MCP server as rejected credentials", async (status) => {
    const service = new SdkMcpToolService({
      serverUrl: "https://mcp.example.com/mcp",
      credentialProvider: { getRequestHeaders: async () => ({ Authorization: "Bearer stale-token" }) },
      fetchImpl: async () => jsonRpcErrorResponse(status, "MCP access token is invalid or expired."),
    });

    const failure = await service.listTools().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(McpCredentialsRejectedError);
    expect(failure).toMatchObject({ status });
    await service.close();
  });

  it("reports any other HTTP failure as an unavailable server", async () => {
    const service = new SdkMcpToolService({
      serverUrl: "https://mcp.example.com/mcp",
      fetchImpl: async () => jsonRpcErrorResponse(500, "upstream exploded"),
    });

    await expect(service.listTools()).rejects.toBeInstanceOf(McpServerUnavailableError);
    await service.close();
  });

  it("reports a hung server as an unavailable server", async () => {
    const service = new SdkMcpToolService({ timeoutMs: 50, transportFactory: () => hangingTransport() });

    await expect(service.listTools()).rejects.toBeInstanceOf(McpServerUnavailableError);
    await service.close();
  });
});
