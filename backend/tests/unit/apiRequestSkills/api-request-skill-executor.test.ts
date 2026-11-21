import type { SkillArgumentOrigin } from "@radioso/conversation-contract";
import { describe, expect, it, vi } from "vitest";

import {
  ApiRequestSkillExecutor,
  type ApiConnectionTarget,
  type ApiRequestSender,
} from "../../../src/modules/apiRequestSkills/public.js";
import type { PublicHttpRequest, PublicHttpRequestResult } from "../../../src/shared/infra/http/publicHttpRequest.js";
import { MetricsRegistry } from "../../../src/shared/observability/metrics/metricsRegistry.js";

const noopEmit = { emitStatus: async () => undefined, emitCustom: async () => undefined };
const CONNECTION_ID = "33333333-3333-4333-8333-333333333333";

const target = (overrides: Partial<ApiConnectionTarget> = {}): ApiConnectionTarget => ({
  id: CONNECTION_ID,
  baseUrl: "https://api.example.com/v1",
  authScheme: "bearer",
  authHeaderName: null,
  credential: "token-123",
  defaultHeaders: { "X-Api-Version": "2024-01" },
  ...overrides,
});

const skill = (config: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
  skillName: "order_status",
  kind: "api_request",
  enabled: true,
  targetId: CONNECTION_ID,
  config,
  ...overrides,
});

const orderLookup = {
  method: "GET",
  path: "/orders/{order_number}",
  exposedParams: { order_number: { type: "text", slotBinding: "order" } },
  boundParams: { expand: "items" },
  outputs: {
    order_status: { path: "order.status", type: "text", description: "Order status" },
    first_item: { path: "items.0.title", type: "text" },
    carrier: { path: "order.carrier", type: "text" },
  },
};

const orderContract = {
  order_status: { type: "text", description: "Order status" },
  first_item: { type: "text" },
  carrier: { type: "text" },
};

const respond = (status: number, body: unknown, contentType = "application/json"): PublicHttpRequestResult => ({
  kind: "response",
  status,
  body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
  contentType,
  durationMs: 12,
});

const harness = (input: {
  config?: Record<string, unknown>;
  skillOverrides?: Record<string, unknown>;
  connection?: ApiConnectionTarget | "not_found" | "credential_unavailable";
  answer?: PublicHttpRequestResult;
}) => {
  const sent: PublicHttpRequest[] = [];
  const send: ApiRequestSender = vi.fn(async (request) => {
    sent.push(request);
    return input.answer ?? respond(200, {});
  });
  const metrics = new MetricsRegistry();
  const warn = vi.fn();
  const connection = input.connection ?? target();
  const executor = new ApiRequestSkillExecutor({
    skills: { findByName: async () => skill(input.config ?? orderLookup, input.skillOverrides) },
    connections: {
      resolveTarget: async () => typeof connection === "string" ? { kind: connection } : { kind: "found", target: connection },
    },
    send,
    metricsRegistry: metrics,
    logger: { warn },
  });
  const dispatch = (
    collected: Record<string, unknown>,
    collectedOrigins?: Record<string, SkillArgumentOrigin>,
  ) =>
    executor.dispatch({
      skill: { name: "order_status" },
      collected,
      ...(collectedOrigins ? { collectedOrigins } : {}),
      context: { agentId: "agent-1", workspaceId: "workspace-1", sessionId: "session-1" },
      emit: noopEmit,
    });
  return { dispatch, sent, send, metrics, warn };
};

const settledWith = (status: string, outputs: Record<string, unknown>, outputContract?: Record<string, unknown>) => ({
  disposition: "settled",
  outcome: { status, outputs, ...(outputContract ? { outputContract } : {}) },
});

describe("ApiRequestSkillExecutor", () => {
  it("places params, authenticates, and returns only the declared outputs that are present", async () => {
    const { dispatch, sent } = harness({
      answer: respond(200, {
        order: { status: "shipped", internalNote: "never leaves" },
        items: [{ title: "Lamp" }],
        customer: { email: "visitor@example.com" },
      }),
    });

    const result = await dispatch({ order: "A-100" }, { order: "slot" });

    expect(result).toEqual(settledWith("completed", { order_status: "shipped", first_item: "Lamp" }, orderContract));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      method: "GET",
      url: "https://api.example.com/v1/orders/A-100?expand=items",
    });
    expect(sent[0].body).toBeUndefined();
    expect(sent[0].headers).toMatchObject({
      accept: "application/json",
      authorization: "Bearer token-123",
      "x-api-version": "2024-01",
    });
  });

  it("sends a POST's remaining params as a nested JSON body", async () => {
    const { dispatch, sent } = harness({
      config: {
        method: "POST",
        path: "/tickets",
        boundParams: { priority: "high" },
        exposedParams: { "customer.email": { type: "email", slotBinding: "email" }, subject: { type: "text" }, count: { type: "number", required: false } },
      },
      connection: target({ authScheme: "header", authHeaderName: "X-Api-Key", credential: "key-1" }),
      answer: respond(201, { id: "t-1" }),
    });

    const result = await dispatch({ email: " visitor@example.com ", subject: "Late", count: "2" }, { email: "slot", subject: "slot", count: "slot" });

    expect(result).toEqual(settledWith("completed", {}));
    expect(JSON.parse(sent[0].body ?? "")).toEqual({ priority: "high", customer: { email: "visitor@example.com" }, subject: "Late", count: 2 });
    expect(sent[0].headers).toMatchObject({ "content-type": "application/json", "x-api-key": "key-1" });
    expect(sent[0].headers).not.toHaveProperty("authorization");
  });

  it("sends a basic credential as an Authorization header", async () => {
    const { dispatch, sent } = harness({ connection: target({ authScheme: "basic", credential: "user:pass" }) });

    await dispatch({ order: "A-1" });

    expect(sent[0].headers?.authorization).toBe(`Basic ${Buffer.from("user:pass").toString("base64")}`);
  });

  it("settles missing_input and sends nothing when a required input was not collected", async () => {
    const { dispatch, send } = harness({});

    const result = await dispatch({});

    expect(result).toEqual(settledWith("missing_input", { missingInputs: ["order"] }));
    expect(send).not.toHaveBeenCalled();
  });

  it("settles unverified and sends nothing when a verifiedOnly input did not come from a verified context variable", async () => {
    const verifiedConfig = {
      method: "GET",
      path: "/customers/{email}/orders",
      exposedParams: { email: { type: "email", slotBinding: "customer_email", verifiedOnly: true } },
    };

    for (const origin of ["slot", "context", "literal", undefined] as const) {
      const { dispatch, send } = harness({ config: verifiedConfig });
      const result = await dispatch(
        { customer_email: "someone-else@example.com" },
        origin ? { customer_email: origin } : undefined,
      );
      expect(result, String(origin)).toEqual(settledWith("unverified", { unverifiedInputs: ["customer_email"] }));
      expect(send).not.toHaveBeenCalled();
    }

    const absent = harness({ config: verifiedConfig });
    expect(await absent.dispatch({})).toEqual(settledWith("unverified", { unverifiedInputs: ["customer_email"] }));

    const verified = harness({ config: verifiedConfig, answer: respond(200, []) });
    const result = await verified.dispatch({ customer_email: "signed@example.com" }, { customer_email: "verified_context" });
    expect(result).toMatchObject({ outcome: { status: "completed" } });
    expect(verified.sent[0].url).toBe("https://api.example.com/v1/customers/signed%40example.com/orders");
  });

  it("settles unverified for an optional verifiedOnly param with no verified value, never sending without it", async () => {
    const optionalVerified = {
      method: "GET",
      path: "/orders/{order_number}",
      exposedParams: {
        order_number: { type: "text" },
        email: { type: "email", slotBinding: "customer_email", verifiedOnly: true, required: false },
      },
    };

    const absent = harness({ config: optionalVerified });
    expect(await absent.dispatch({ order_number: "A-1" }, { order_number: "slot" }))
      .toEqual(settledWith("unverified", { unverifiedInputs: ["customer_email"] }));
    expect(absent.send).not.toHaveBeenCalled();

    const typed = harness({ config: optionalVerified });
    expect(await typed.dispatch({ order_number: "A-1", customer_email: "someone@example.com" }, { order_number: "slot", customer_email: "slot" }))
      .toEqual(settledWith("unverified", { unverifiedInputs: ["customer_email"] }));
    expect(typed.send).not.toHaveBeenCalled();
  });

  it("settles invalid_input and sends nothing when a collected value does not fit its type", async () => {
    const { dispatch, send } = harness({
      config: { method: "GET", path: "/orders", exposedParams: { placed: { type: "date" }, count: { type: "number" } } },
    });

    expect(await dispatch({ placed: "last tuesday", count: "3" })).toEqual(settledWith("invalid_input", { invalidInputs: ["placed"] }));
    expect(send).not.toHaveBeenCalled();
  });

  it("fails with response_mismatch, naming the outputs, when a required output is absent", async () => {
    const { dispatch } = harness({
      config: { ...orderLookup, outputs: { order_status: { path: "order.status", type: "text", required: true }, total: { path: "order.total", type: "number", required: true } } },
      answer: respond(200, { order: { total: "n/a" } }),
    });

    expect(await dispatch({ order: "A-1" })).toEqual(
      settledWith("failed", { reason: "response_mismatch", httpStatus: 200, missingOutputs: ["order_status", "total"] }),
    );
  });

  it.each([
    [404, "not_found", {}],
    [422, "rejected", { httpStatus: 422 }],
    [400, "rejected", { httpStatus: 400 }],
    [401, "failed", { reason: "auth_rejected", httpStatus: 401 }],
    [403, "failed", { reason: "auth_rejected", httpStatus: 403 }],
    [429, "failed", { reason: "rate_limited", httpStatus: 429 }],
    [500, "failed", { reason: "upstream_error", httpStatus: 500 }],
  ])("maps status %i to %s without reading the body into outputs", async (status, outcome, outputs) => {
    const { dispatch } = harness({ answer: respond(status, { error: "visitor@example.com is not allowed" }) });

    expect(await dispatch({ order: "A-1" })).toEqual(settledWith(outcome, outputs));
  });

  it("fails on a transport failure with its reason", async () => {
    const { dispatch } = harness({ answer: { kind: "failed", reason: "timeout", durationMs: 10_000 } });

    expect(await dispatch({ order: "A-1" })).toEqual(settledWith("failed", { reason: "timeout" }));
  });

  it("fails when outputs are declared but the body is not JSON", async () => {
    const { dispatch } = harness({ answer: respond(200, "<html>ok</html>", "text/html") });

    expect(await dispatch({ order: "A-1" })).toEqual(settledWith("failed", { reason: "non_json_response", httpStatus: 200 }));
  });

  it("completes with no outputs when the body is empty", async () => {
    const { dispatch } = harness({ answer: respond(204, "") });

    expect(await dispatch({ order: "A-1" })).toEqual(settledWith("completed", {}, orderContract));
  });

  it("fails when the declared outputs are too large", async () => {
    const { dispatch } = harness({ answer: respond(200, { order: { status: "x".repeat(20_000) } }) });

    expect(await dispatch({ order: "A-1" })).toEqual(settledWith("failed", { reason: "outputs_too_large", httpStatus: 200 }));
  });

  it("fails without sending when the connection is gone or its credential cannot be read", async () => {
    for (const connection of ["not_found", "credential_unavailable"] as const) {
      const { dispatch, send } = harness({ connection });
      expect(await dispatch({ order: "A-1" })).toEqual(
        settledWith("failed", { reason: connection === "not_found" ? "connection_not_found" : "credential_unavailable" }),
      );
      expect(send).not.toHaveBeenCalled();
    }
  });

  it("fails without sending for a disabled skill, another kind, or a path value that is not a segment", async () => {
    expect(await harness({ skillOverrides: { enabled: false } }).dispatch({ order: "A-1" }))
      .toEqual(settledWith("failed", { reason: "skill_not_found" }));
    expect(await harness({ skillOverrides: { kind: "webhook" } }).dispatch({ order: "A-1" }))
      .toEqual(settledWith("failed", { reason: "skill_not_found" }));
    const dotSegment = harness({});
    expect(await dotSegment.dispatch({ order: ".." })).toEqual(settledWith("invalid_input", { invalidInputs: ["order"] }));
    expect(dotSegment.send).not.toHaveBeenCalled();
  });

  it("counts each outcome and logs a failure by ids and reason only", async () => {
    const { dispatch, metrics, warn } = harness({ answer: respond(500, { error: "visitor@example.com" }) });

    await dispatch({ order: "A-SECRET-1" });

    const exposition = metrics.renderPrometheus();
    expect(exposition).toContain('api_request_skill_dispatch_total{outcome="failed",reason="upstream_error"} 1');
    expect(warn).toHaveBeenCalledOnce();
    const logged = JSON.stringify(warn.mock.calls[0]);
    expect(logged).toContain("api_request_skill_failed");
    expect(logged).toContain("upstream_error");
    expect(logged).toContain(CONNECTION_ID);
    expect(logged).not.toContain("A-SECRET-1");
    expect(logged).not.toContain("api.example.com");
    expect(logged).not.toContain("visitor@example.com");
    expect(logged).not.toContain("token-123");
  });
});
