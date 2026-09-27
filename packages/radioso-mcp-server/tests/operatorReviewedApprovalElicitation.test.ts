import { describe, expect, it, vi } from "vitest";
import { OPERATOR_MCP_URL_ELICITATION_KEY, digestOperatorMcpCall } from "@radioso/operator-mcp-contract";
import { createOperatorMcpRequestHandler, type OperatorMcpRequestHandlerDependencies } from "../src/operator/requestHandler.js";

// Covers slice 3 of the reviewed-approval gate: mapping the backend's `approval_required`
// outcome to 2026-07-28 MRTR URL-mode elicitation (SEP-2322) for clients that declare it, while
// every other client keeps today's plain-link behavior. The edge holds no session or in-memory
// state -- every scenario below is provable from a single request/response pair, and the
// statelessness test constructs two independent handler instances to demonstrate it.

const proof = {
  version: 1 as const,
  grantId: "00000000-0000-4000-8000-000000000001",
  grantVersion: 1,
  accountId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000001",
  clientId: "https://client.example/cimd",
  resource: "https://mcp.example/operator/mcp",
  method: "tools/call" as const,
  descriptorName: "execute_reviewed_proposal",
  invocationId: "00000000-0000-4000-8000-000000000001",
  bodyDigest: "fG4t0zZQJrS3cT9u1q6Yl8m8fJ5u8w3s9z2x0c1v2b3".slice(0, 43),
  issuedAt: Date.now() - 1000,
  expiresAt: Date.now() + 10_000,
  nonce: "nonce",
  signature: "fG4t0zZQJrS3cT9u1q6Yl8m8fJ5u8w3s9z2x0c1v2b3".slice(0, 43),
};

const TOOL_NAME = "execute_reviewed_proposal";
const CALL_ARGUMENTS = { proposalId: "11111111-1111-4111-8111-111111111111", reviewDigest: "digest-abc" };
const APPROVAL_URL = "https://app.example/oauth/operator-mcp/proposal/11111111-1111-4111-8111-111111111111";

const approvalRequiredResult = {
  content: [],
  structuredContent: {
    proposalId: CALL_ARGUMENTS.proposalId,
    status: "approval_required",
    approval: {
      url: APPROVAL_URL,
      expiresAt: "2026-09-27T12:00:00.000Z",
      effect: { exposure: "live", metered: false, reversibility: "irreversible" },
    },
  },
};

const appliedResult = {
  content: [],
  structuredContent: { proposalId: CALL_ARGUMENTS.proposalId, status: "applied", appliedRef: { id: "ref-1" } },
};

const urlCapableMeta = { elicitation: { url: {} } };

const modernRequest = (input: {
  id?: string | number;
  arguments?: Record<string, unknown>;
  operationId?: string;
  inputResponses?: Record<string, unknown>;
  clientCapabilities?: Record<string, unknown>;
}): Request => {
  const body = {
    id: input.id ?? "1",
    jsonrpc: "2.0",
    method: "tools/call",
    params: {
      _meta: {
        "io.modelcontextprotocol/clientCapabilities": input.clientCapabilities ?? {},
        "io.modelcontextprotocol/clientInfo": { name: "operator-test", version: "1.0.0" },
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      },
      arguments: input.arguments ?? CALL_ARGUMENTS,
      name: TOOL_NAME,
      ...(input.operationId ? { operationId: input.operationId } : {}),
      ...(input.inputResponses ? { inputResponses: input.inputResponses } : {}),
    },
  };
  return new Request("https://mcp.example/operator/mcp", {
    body: JSON.stringify(body),
    headers: {
      authorization: "Bearer opaque-access-token",
      "content-type": "application/json",
      "mcp-method": "tools/call",
      "mcp-name": TOOL_NAME,
      "mcp-protocol-version": "2026-07-28",
    },
    method: "POST",
  });
};

const legacyToolCallRequest = (): Request => new Request("https://mcp.example/operator/mcp", {
  body: JSON.stringify({
    id: "1",
    jsonrpc: "2.0",
    method: "tools/call",
    params: { arguments: CALL_ARGUMENTS, name: TOOL_NAME },
  }),
  headers: {
    authorization: "Bearer opaque-access-token",
    "content-type": "application/json",
    "mcp-protocol-version": "2025-06-18",
  },
  method: "POST",
});

const buildDependencies = (
  callImpl: OperatorMcpRequestHandlerDependencies["call"],
): OperatorMcpRequestHandlerDependencies => ({
  admit: vi.fn<OperatorMcpRequestHandlerDependencies["admit"]>(async () => ({ proof })),
  call: vi.fn<OperatorMcpRequestHandlerDependencies["call"]>(callImpl),
  list: vi.fn<OperatorMcpRequestHandlerDependencies["list"]>(async () => ({ tools: [] })),
});

describe("operator MCP reviewed-approval URL elicitation", () => {
  it("(a) offers a URL-mode elicitation to a 2026-07-28 client that declared it, and an accept retry after the backend has recorded a dashboard approval passes through applied", async () => {
    const call = vi.fn()
      .mockResolvedValueOnce(approvalRequiredResult)
      // Standing in for the backend re-checking the proposal row after the person approved on
      // the dashboard page in between these two calls -- the edge itself never records approval.
      .mockResolvedValueOnce(appliedResult);
    const dependencies = buildDependencies(call);
    const handler = createOperatorMcpRequestHandler(dependencies);

    const first = await handler(modernRequest({ clientCapabilities: urlCapableMeta }));
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { result: Record<string, unknown> };
    expect(firstBody.result.resultType).toBe("input_required");
    expect(firstBody.result).not.toHaveProperty("structuredContent");
    const inputRequests = firstBody.result.inputRequests as Record<string, unknown>;
    expect(inputRequests[OPERATOR_MCP_URL_ELICITATION_KEY]).toMatchObject({
      method: "elicitation/create",
      params: { mode: "url", url: APPROVAL_URL },
    });

    const retry = await handler(modernRequest({
      clientCapabilities: urlCapableMeta,
      inputResponses: { [OPERATOR_MCP_URL_ELICITATION_KEY]: { action: "accept" } },
    }));
    expect(retry.status).toBe(200);
    const retryBody = await retry.json() as { result: Record<string, unknown> };
    expect(retryBody.result.resultType).toBe("complete");
    expect(retryBody.result.structuredContent).toEqual(appliedResult.structuredContent);

    // The retry replays the same logical call: identical name/arguments/bodyDigest, and nothing
    // about the elicitation travels to the backend -- the edge is a pure protocol adapter.
    const expectedBodyDigest = digestOperatorMcpCall({ arguments: CALL_ARGUMENTS, name: TOOL_NAME });
    expect(call).toHaveBeenCalledTimes(2);
    expect(call).toHaveBeenNthCalledWith(1, expect.objectContaining({
      arguments: CALL_ARGUMENTS, name: TOOL_NAME, bodyDigest: expectedBodyDigest,
    }));
    expect(call).toHaveBeenNthCalledWith(2, expect.objectContaining({
      arguments: CALL_ARGUMENTS, name: TOOL_NAME, bodyDigest: expectedBodyDigest,
    }));
    for (const [args] of call.mock.calls) {
      expect(args).not.toHaveProperty("inputResponses");
      expect(args).not.toHaveProperty("elicitation");
    }
  });

  it("(a2) an accept retry with no dashboard approval yet still gets the backend's real approval_required, passed through and not treated as approval", async () => {
    // `accept` means only that the person agreed to open the page (per spec, URL-mode consent is
    // not consent to the change). If they retry before actually approving on the dashboard, the
    // backend re-checks the same proposal row and finds it still unapproved.
    const call = vi.fn()
      .mockResolvedValueOnce(approvalRequiredResult)
      .mockResolvedValueOnce(approvalRequiredResult);
    const dependencies = buildDependencies(call);
    const handler = createOperatorMcpRequestHandler(dependencies);

    await handler(modernRequest({ clientCapabilities: urlCapableMeta }));
    const retry = await handler(modernRequest({
      clientCapabilities: urlCapableMeta,
      inputResponses: { [OPERATOR_MCP_URL_ELICITATION_KEY]: { action: "accept" } },
    }));

    expect(retry.status).toBe(200);
    const body = await retry.json() as { result: Record<string, unknown> };
    // Passed through as the complete result, not re-wrapped in a second elicitation.
    expect(body.result.resultType).toBe("complete");
    expect(body.result.structuredContent).toEqual(approvalRequiredResult.structuredContent);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("(b) leaves the plain link result unchanged for a client that never declared URL elicitation", async () => {
    const dependencies = buildDependencies(async () => approvalRequiredResult);
    const handler = createOperatorMcpRequestHandler(dependencies);

    const response = await handler(modernRequest({ clientCapabilities: {} }));
    expect(response.status).toBe(200);
    const body = await response.json() as { result: Record<string, unknown> };
    expect(body.result.resultType).toBe("complete");
    expect(body.result.structuredContent).toEqual(approvalRequiredResult.structuredContent);
  });

  it("(b) leaves the plain link result unchanged for a client that declares `url` as false, null, or an array", async () => {
    for (const malformedUrl of [false, null, []]) {
      const dependencies = buildDependencies(async () => approvalRequiredResult);
      const handler = createOperatorMcpRequestHandler(dependencies);

      const response = await handler(modernRequest({ clientCapabilities: { elicitation: { url: malformedUrl } } }));
      expect(response.status).toBe(200);
      const body = await response.json() as { result: Record<string, unknown> };
      expect(body.result.resultType).toBe("complete");
      expect(body.result.structuredContent).toEqual(approvalRequiredResult.structuredContent);
    }
  });

  it("(b) leaves the plain link result unchanged for a client on an older protocol version", async () => {
    const dependencies = buildDependencies(async () => approvalRequiredResult);
    const handler = createOperatorMcpRequestHandler(dependencies);

    const response = await handler(legacyToolCallRequest());
    expect(response.status).toBe(200);
    const body = await response.json() as { result: Record<string, unknown> };
    expect(body.result).not.toHaveProperty("resultType");
    expect(body.result.structuredContent).toEqual(approvalRequiredResult.structuredContent);
  });

  it("(c) maps a decline or cancel retry to the backend's own refusal-shaped outcome, never an outage", async () => {
    for (const action of ["decline", "cancel"] as const) {
      const call = vi.fn()
        .mockResolvedValueOnce(approvalRequiredResult)
        .mockResolvedValueOnce({
          content: [],
          structuredContent: { proposalId: CALL_ARGUMENTS.proposalId, reason: "canceled", status: "refused" },
        });
      const dependencies = buildDependencies(call);
      const handler = createOperatorMcpRequestHandler(dependencies);

      await handler(modernRequest({ clientCapabilities: urlCapableMeta }));
      const retry = await handler(modernRequest({
        clientCapabilities: urlCapableMeta,
        inputResponses: { [OPERATOR_MCP_URL_ELICITATION_KEY]: { action } },
      }));

      expect(retry.status).toBe(200);
      const body = await retry.json() as Record<string, unknown>;
      expect(body).not.toHaveProperty("error");
      const result = body.result as Record<string, unknown>;
      expect(result.resultType).toBe("complete");
      expect(result.structuredContent).toEqual({ proposalId: CALL_ARGUMENTS.proposalId, reason: "canceled", status: "refused" });
    }
  });

  it("rejects a malformed or oversized inputResponses payload with invalid params", async () => {
    const dependencies = buildDependencies(async () => approvalRequiredResult);
    const handler = createOperatorMcpRequestHandler(dependencies);

    const malformedAction = await handler(modernRequest({
      clientCapabilities: urlCapableMeta,
      inputResponses: { [OPERATOR_MCP_URL_ELICITATION_KEY]: { action: "maybe" } },
    }));
    expect(malformedAction.status).toBe(200);
    await expect(malformedAction.json()).resolves.toMatchObject({ error: { code: -32602 } });

    const tooManyKeys = await handler(modernRequest({
      clientCapabilities: urlCapableMeta,
      inputResponses: { a: {}, b: {}, c: {}, d: {}, e: {} },
    }));
    expect(tooManyKeys.status).toBe(200);
    await expect(tooManyKeys.json()).resolves.toMatchObject({ error: { code: -32602 } });

    expect(dependencies.call).not.toHaveBeenCalled();
  });

  it("(d) needs no edge-instance state: a second, independent handler instance serves the retry", async () => {
    // Instance A only ever sees the first call; instance B only ever sees the retry. Nothing in
    // the module or either instance's closure carries information between them -- only the
    // backend mock (standing in for the shared Postgres row) knows the operation's history.
    const backendCall = vi.fn()
      .mockResolvedValueOnce(approvalRequiredResult)
      .mockResolvedValueOnce(appliedResult);
    const instanceA = createOperatorMcpRequestHandler(buildDependencies(backendCall));
    const instanceB = createOperatorMcpRequestHandler(buildDependencies(backendCall));

    const first = await instanceA(modernRequest({ clientCapabilities: urlCapableMeta }));
    const firstBody = await first.json() as { result: Record<string, unknown> };
    expect(firstBody.result.resultType).toBe("input_required");

    const retry = await instanceB(modernRequest({
      clientCapabilities: urlCapableMeta,
      inputResponses: { [OPERATOR_MCP_URL_ELICITATION_KEY]: { action: "accept" } },
    }));
    const retryBody = await retry.json() as { result: Record<string, unknown> };
    expect(retryBody.result.resultType).toBe("complete");
    expect(retryBody.result.structuredContent).toEqual(appliedResult.structuredContent);
  });
});
