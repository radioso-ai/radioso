import { describe, expect, it } from "vitest";

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { connectMockMcpServer, type MockTool } from "../../support/mockMcpServer.js";
import { SdkMcpToolService } from "../../../src/modules/externalSkills/toolService/sdkMcpToolService.js";

/** A transport whose `start()` never resolves — simulates a hung/unreachable server. */
const hangingTransport = (): Transport =>
  ({
    start: () => new Promise<void>(() => undefined),
    send: async () => undefined,
    close: async () => undefined,
  });

const serviceFor = async (tools: MockTool[]): Promise<SdkMcpToolService> => {
  const { clientTransport } = await connectMockMcpServer(tools);
  return new SdkMcpToolService({ transportFactory: () => clientTransport });
};

describe("SdkMcpToolService", () => {
  it("lists discovered tools with their input schemas", async () => {
    const service = await serviceFor([
      {
        name: "post_message",
        description: "Post a message",
        inputSchema: {
          type: "object",
          properties: { channel: { type: "string" }, message: { type: "string" } },
          required: ["channel", "message"],
        },
        respond: () => ({ content: [{ type: "text", text: "ok" }] }),
      },
    ]);

    const tools = await service.listTools();
    expect(tools.map((tool) => tool.name)).toContain("post_message");
    expect(tools[0]?.inputSchema).toMatchObject({ properties: { channel: { type: "string" } } });
    await service.close();
  });

  it("maps a successful tool call to completed with answer + structured outputs", async () => {
    const service = await serviceFor([
      {
        name: "book",
        respond: (args) => ({
          content: [{ type: "text", text: "booked" }],
          structuredContent: { bookingId: "b1", echoed: args },
        }),
      },
    ]);

    const result = await service.callTool({ toolName: "book", input: { when: "tue" } });
    expect(result.status).toBe("completed");
    expect(result.answer).toBe("booked");
    expect(result.outputs).toMatchObject({ bookingId: "b1", echoed: { when: "tue" } });
    await service.close();
  });

  it("maps an isError result to a failed outcome", async () => {
    const service = await serviceFor([
      { name: "book", respond: () => ({ content: [{ type: "text", text: "slot taken" }], isError: true }) },
    ]);

    const result = await service.callTool({ toolName: "book", input: {} });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("mcp_tool_error");
    expect(result.answer).toBe("slot taken");
    await service.close();
  });

  it("maps a connection/transport failure to a failed outcome", async () => {
    const service = new SdkMcpToolService({
      transportFactory: () => {
        throw new Error("boom");
      },
    });

    const result = await service.callTool({ toolName: "anything", input: {} });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("mcp_call_failed");
  });

  it("does not leak raw exception text into the failed result", async () => {
    const secret = "super-secret-token-xyz";
    const service = new SdkMcpToolService({
      transportFactory: () => {
        throw new Error(`connect failed for https://host?token=${secret}`);
      },
    });

    const result = await service.callTool({ toolName: "anything", input: {} });
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.error?.message).toBe("External tool call failed");
  });

  it("bounds a hung connection by the timeout and fails safely", async () => {
    const service = new SdkMcpToolService({
      timeoutMs: 50,
      transportFactory: () => hangingTransport(),
    });

    const start = Date.now();
    const result = await service.callTool({ toolName: "anything", input: {} });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("mcp_timeout");
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("completes a slow tool call bounded by callTimeoutMs even past the shorter connect/discovery timeoutMs", async () => {
    const { clientTransport } = await connectMockMcpServer([
      {
        name: "converse",
        respond: async () => {
          await new Promise((resolve) => setTimeout(resolve, 400));
          return { content: [{ type: "text", text: "answered" }] };
        },
      },
    ]);
    // The in-memory connect must finish inside timeoutMs, so keep that bound generous
    // enough not to flake under parallel load while still well under the tool delay.
    const service = new SdkMcpToolService({
      timeoutMs: 200,
      callTimeoutMs: 800,
      transportFactory: () => clientTransport,
    });

    const result = await service.callTool({ toolName: "converse", input: {} });
    expect(result.status).toBe("completed");
    expect(result.answer).toBe("answered");
    await service.close();
  });

  it("bounds a slow tool call by callTimeoutMs and fails safely with mcp_timeout", async () => {
    const { clientTransport } = await connectMockMcpServer([
      {
        name: "converse",
        respond: async () => {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          return { content: [{ type: "text", text: "too late" }] };
        },
      },
    ]);
    const service = new SdkMcpToolService({
      timeoutMs: 5000,
      callTimeoutMs: 50,
      transportFactory: () => clientTransport,
    });

    const start = Date.now();
    const result = await service.callTool({ toolName: "converse", input: {} });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("mcp_timeout");
    expect(Date.now() - start).toBeLessThan(2000);
    await service.close();
  });

  it("connects once under concurrent first calls", async () => {
    const { clientTransport } = await connectMockMcpServer([
      { name: "ping", respond: () => ({ content: [{ type: "text", text: "pong" }] }) },
    ]);
    let builds = 0;
    const service = new SdkMcpToolService({
      transportFactory: () => {
        builds += 1;
        return clientTransport;
      },
    });

    const [a, b] = await Promise.all([service.listTools(), service.listTools()]);
    expect(builds).toBe(1);
    expect(a.map((t) => t.name)).toEqual(["ping"]);
    expect(b.map((t) => t.name)).toEqual(["ping"]);
    await service.close();
  });

  it("honors an aborted signal from the call context", async () => {
    const { clientTransport } = await connectMockMcpServer([
      { name: "slow", respond: () => ({ content: [{ type: "text", text: "ok" }] }) },
    ]);
    const service = new SdkMcpToolService({ transportFactory: () => clientTransport });

    const result = await service.callTool({
      toolName: "slow",
      input: {},
      context: { signal: AbortSignal.abort() },
    });
    expect(result.status).toBe("failed");
    // The SDK reports a caller abort as a RequestTimeout McpError; it must not be
    // misclassified as a retryable timeout.
    expect(result.error).toMatchObject({ code: "mcp_call_aborted", retryable: false });
    await service.close();
  });

  it("refuses to connect when the SSRF guard rejects the server URL (runtime path)", async () => {
    // The guard throws before any transport is built, so no outbound call happens.
    const service = new SdkMcpToolService({
      serverUrl: "https://169.254.169.254",
      assertPublicUrl: (url) => {
        throw new Error(`blocked non-public host: ${url}`);
      },
    });

    const result = await service.callTool({ toolName: "anything", input: {} });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("mcp_call_failed");
  });
});
