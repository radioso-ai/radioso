import { describe, expect, it } from "vitest";

import { a2aError, jsonRpcErrorResponse, radiosoError, rpcErrorForTurnFailure } from "../../../src/modules/a2a/domain/a2aErrors.js";
import { activatedExtensions, parseJsonRpcCall, requestedA2aVersion } from "../../../src/modules/a2a/domain/jsonRpc.js";
import { AppError } from "../../../src/shared/domain/errors.js";

const call = (overrides: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id: "req-1",
  method: "GetTask",
  params: { id: "task-1" },
  ...overrides,
});

const parse = (body: unknown, ...version: [string | undefined] | []) =>
  parseJsonRpcCall({ body, version: version.length === 0 ? "1.0" : version[0] });

const errorOf = (result: ReturnType<typeof parse>) => {
  if (result.ok) throw new Error("expected a refusal");
  return { id: result.id, code: result.error.code, reason: result.error.reason };
};

describe("parseJsonRpcCall", () => {
  it("accepts a v1.0 call to a served method", () => {
    expect(parse(call())).toEqual({ ok: true, call: { id: "req-1", method: "GetTask", params: { id: "task-1" } } });
    expect(parse(call({ id: 7, method: "SendMessage" }))).toMatchObject({ ok: true, call: { id: 7, method: "SendMessage" } });
  });

  it("answers a batch with -32600, since the binding serves one call per request", () => {
    expect(errorOf(parse([call()]))).toEqual({ id: null, code: -32600, reason: "INVALID_REQUEST" });
  });

  it("answers a body that is not a JSON-RPC 2.0 request with -32600, echoing a usable id", () => {
    expect(errorOf(parse(undefined))).toEqual({ id: null, code: -32600, reason: "INVALID_REQUEST" });
    expect(errorOf(parse("text"))).toEqual({ id: null, code: -32600, reason: "INVALID_REQUEST" });
    expect(errorOf(parse(call({ jsonrpc: "1.0" })))).toEqual({ id: "req-1", code: -32600, reason: "INVALID_REQUEST" });
    expect(errorOf(parse(call({ method: 7 })))).toEqual({ id: "req-1", code: -32600, reason: "INVALID_REQUEST" });
    expect(errorOf(parse(call({ id: { nested: true } })))).toEqual({ id: null, code: -32600, reason: "INVALID_REQUEST" });
    // A2A has no notifications: a call without an id is not a call this binding serves.
    const { id: _id, ...withoutId } = call();
    expect(errorOf(parse(withoutId))).toEqual({ id: null, code: -32600, reason: "INVALID_REQUEST" });
  });

  it("answers -32009 when A2A-Version is absent (meaning 0.3) or anything but 1.0", () => {
    expect(errorOf(parse(call(), undefined))).toEqual({ id: "req-1", code: -32009, reason: "VERSION_NOT_SUPPORTED" });
    expect(errorOf(parse(call(), "0.3"))).toEqual({ id: "req-1", code: -32009, reason: "VERSION_NOT_SUPPORTED" });
    expect(errorOf(parse(call(), "2.0"))).toEqual({ id: "req-1", code: -32009, reason: "VERSION_NOT_SUPPORTED" });
    expect(parse(call(), " 1.0 ")).toMatchObject({ ok: true });
  });

  it("reads the version from the A2A-Version header, or from the query parameter when no header is sent", () => {
    expect(requestedA2aVersion({ header: "1.0", query: undefined })).toBe("1.0");
    expect(requestedA2aVersion({ header: undefined, query: "1.0" })).toBe("1.0");
    // The header wins when both are present.
    expect(requestedA2aVersion({ header: "0.3", query: "1.0" })).toBe("0.3");
    expect(requestedA2aVersion({ header: undefined, query: ["1.0", "1.0"] })).toBeUndefined();
    expect(requestedA2aVersion({ header: undefined, query: undefined })).toBeUndefined();
  });

  it("answers streaming and the extended card with -32004, push configs with -32003, and anything else with -32601", () => {
    for (const method of ["SendStreamingMessage", "SubscribeToTask", "GetExtendedAgentCard"]) {
      expect(errorOf(parse(call({ method })))).toEqual({ id: "req-1", code: -32004, reason: "UNSUPPORTED_OPERATION" });
    }
    for (const method of [
      "CreateTaskPushNotificationConfig",
      "GetTaskPushNotificationConfig",
      "ListTaskPushNotificationConfigs",
      "DeleteTaskPushNotificationConfig",
    ]) {
      expect(errorOf(parse(call({ method })))).toEqual({ id: "req-1", code: -32003, reason: "PUSH_NOTIFICATION_NOT_SUPPORTED" });
    }
    expect(errorOf(parse(call({ method: "message/send" })))).toEqual({ id: "req-1", code: -32601, reason: "METHOD_NOT_FOUND" });
  });

  it("answers params that are not an object with -32602", () => {
    expect(errorOf(parse(call({ params: ["task-1"] })))).toEqual({ id: "req-1", code: -32602, reason: "INVALID_PARAMS" });
    expect(errorOf(parse(call({ params: undefined })))).toEqual({ id: "req-1", code: -32602, reason: "INVALID_PARAMS" });
  });
});

describe("JSON-RPC error bodies", () => {
  it("carries a google.rpc.ErrorInfo with the A2A domain for A2A errors", () => {
    expect(jsonRpcErrorResponse("req-1", a2aError("TASK_NOT_FOUND"))).toEqual({
      jsonrpc: "2.0",
      id: "req-1",
      error: {
        code: -32001,
        message: "Task not found",
        data: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "TASK_NOT_FOUND", domain: "a2a-protocol.org", metadata: {} }],
      },
    });
  });

  it("carries Radioso reasons under the Radioso domain, with nothing about the request in them", () => {
    expect(jsonRpcErrorResponse(3, radiosoError("CONTEXT_NOT_FOUND")).error).toEqual({
      code: -32602,
      message: "Context not found",
      data: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "CONTEXT_NOT_FOUND", domain: "radioso.ai", metadata: {} }],
    });
    for (const reason of ["TURN_SUPERSEDED", "TURN_IN_PROGRESS", "USAGE_LIMIT_EXCEEDED"] as const) {
      expect(jsonRpcErrorResponse(3, radiosoError(reason)).error).toMatchObject({ code: -32000, data: [{ reason, domain: "radioso.ai", metadata: {} }] });
    }
  });

  it("words error messages as protocol text for a developer, not as the agent speaking", () => {
    expect(radiosoError("USAGE_LIMIT_EXCEEDED").message).toBe("Workspace usage limit exceeded");
  });

  it("maps a superseded turn and a workspace over quota, and leaves every other failure to the error handler", () => {
    const superseded = new AppError(409, "chat_turn_superseded", "Chat turn was superseded by a newer message.", { conversationId: "c-1" });
    expect(rpcErrorForTurnFailure(superseded)?.reason).toBe("TURN_SUPERSEDED");
    expect(rpcErrorForTurnFailure(new AppError(429, "usage_limit_exceeded", "Over quota", { plan: "free" }))?.reason).toBe("USAGE_LIMIT_EXCEEDED");
    expect(rpcErrorForTurnFailure(new Error("database down"))).toBeNull();
    expect(rpcErrorForTurnFailure(new AppError(503, "service_unavailable", "down"))).toBeNull();
  });
});

describe("activatedExtensions", () => {
  const supported = ["https://docs.example.com/ext/v1"];

  it("activates the requested URIs this server supports, once each, in request order", () => {
    expect(activatedExtensions("https://docs.example.com/ext/v1, https://other.example/x,https://docs.example.com/ext/v1", supported))
      .toEqual(["https://docs.example.com/ext/v1"]);
    expect(activatedExtensions(["https://other.example/x", "https://docs.example.com/ext/v1"], supported)).toEqual(["https://docs.example.com/ext/v1"]);
  });

  it("activates nothing without the header", () => {
    expect(activatedExtensions(undefined, supported)).toEqual([]);
    expect(activatedExtensions("", supported)).toEqual([]);
  });
});
