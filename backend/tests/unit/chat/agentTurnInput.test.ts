import { describe, expect, it, vi } from "vitest";

import { chatRequestInputFor, resolveAgentTurnInput } from "../../../src/modules/chat/services/agentTurnInput.js";
import type { AgentToolCatalogPort, AgentToolDescriptor } from "../../../src/modules/routines/public.js";
import { MetricsRegistry } from "../../../src/shared/observability/metrics/metricsRegistry.js";

const startReturn: AgentToolDescriptor = {
  toolName: "start_return",
  description: "Start a return.",
  routineLineageId: "lineage-return",
  inputSchema: {
    type: "object",
    properties: { orderId: { type: "string" }, reason: { type: "string" } },
    required: ["orderId"],
    additionalProperties: false,
  },
};

const catalogWith = (tools: AgentToolDescriptor[]) => {
  const load = vi.fn(async () => ({ agent: { name: "Acme", description: null }, askAgentDescription: "Hold a conversation with Acme.", tools }));
  const catalog: AgentToolCatalogPort = { load };
  return { catalog, load };
};

const scope = { workspaceId: "ws-1", agentId: "agent-1", agentRevisionId: "rev-3" };

describe("resolveAgentTurnInput", () => {
  it("passes a plain message through without consulting the catalog", async () => {
    const { catalog, load } = catalogWith([startReturn]);
    const metrics = new MetricsRegistry();

    const resolved = await resolveAgentTurnInput(catalog, { ...scope, body: { message: "  hello  " } }, { metrics });

    expect(resolved).toEqual({ kind: "message", message: "hello" });
    expect(load).not.toHaveBeenCalled();
    expect(metrics.renderPrometheus()).toContain('radioso_converse_turns_total{input_kind="message"} 1');
  });

  it("resolves a tool call against the release's catalog and returns the typed invocation with its descriptor", async () => {
    const { catalog, load } = catalogWith([startReturn]);
    const metrics = new MetricsRegistry();

    const resolved = await resolveAgentTurnInput(
      catalog,
      { ...scope, body: { routine: { toolName: "start_return", input: { orderId: "A-1001" } } } },
      { metrics },
    );

    expect(load).toHaveBeenCalledWith(scope);
    expect(resolved).toEqual({
      kind: "routine_invocation",
      invocation: { toolName: "start_return", input: { orderId: "A-1001" } },
      descriptor: startReturn,
    });
    expect(metrics.renderPrometheus()).toContain('radioso_converse_turns_total{input_kind="routine_invocation"} 1');
  });

  it("refuses an unknown tool with 404 routine_tool_unknown", async () => {
    const { catalog } = catalogWith([startReturn]);
    const metrics = new MetricsRegistry();

    await expect(resolveAgentTurnInput(
      catalog,
      { ...scope, body: { routine: { toolName: "cancel_order", input: {} } } },
      { metrics },
    )).rejects.toMatchObject({ statusCode: 404, details: { code: "routine_tool_unknown", toolName: "cancel_order" } });
    expect(metrics.renderPrometheus()).toContain('radioso_routine_invocations_total{outcome="unknown_tool"} 1');
  });

  it("refuses invalid input with 400 routine_invocation_invalid and field-level errors, logging paths only", async () => {
    const { catalog } = catalogWith([startReturn]);
    const metrics = new MetricsRegistry();
    const logger = { info: vi.fn() };

    await expect(resolveAgentTurnInput(
      catalog,
      { ...scope, body: { routine: { toolName: "start_return", input: { reason: 42, extra: "secret-value" } } } },
      { metrics, logger },
    )).rejects.toMatchObject({
      statusCode: 400,
      details: {
        code: "routine_invocation_invalid",
        errors: [
          { path: "orderId", code: "required" },
          { path: "reason", code: "type" },
          { path: "extra", code: "unknown_field" },
        ],
      },
    });
    expect(metrics.renderPrometheus()).toContain('radioso_routine_invocations_total{outcome="validation_failed"} 1');
    expect(logger.info).toHaveBeenCalledTimes(1);
    const [fields, message] = logger.info.mock.calls[0];
    expect(fields).toMatchObject({ agentId: "agent-1", toolName: "start_return", errorPaths: ["orderId", "reason", "extra"] });
    expect(JSON.stringify(fields)).not.toContain("secret-value");
    expect(typeof message).toBe("string");
  });

  it("refuses a body that names neither a message nor a routine", async () => {
    const { catalog } = catalogWith([startReturn]);

    await expect(resolveAgentTurnInput(catalog, { ...scope, body: {} })).rejects.toMatchObject({ statusCode: 400 });
    await expect(resolveAgentTurnInput(catalog, { ...scope, body: { message: "   " } })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("chatRequestInputFor", () => {
  it("maps each turn input onto the chat request's message or routineInvocation field", () => {
    expect(chatRequestInputFor({ kind: "message", message: "hi" })).toEqual({ message: "hi" });
    const invocation = { toolName: "start_return", input: { orderId: "A-1001" } };
    expect(chatRequestInputFor({ kind: "routine_invocation", invocation, descriptor: startReturn })).toEqual({
      routineInvocation: invocation,
    });
  });
});
