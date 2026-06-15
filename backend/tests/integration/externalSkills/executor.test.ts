import { describe, expect, it } from "vitest";

import { createToolSkillExecutor } from "@radioso/conversation-tools";

import { connectMockMcpServer, type MockTool } from "../../support/mockMcpServer.js";
import { SdkMcpToolService } from "../../../src/modules/externalSkills/toolService/sdkMcpToolService.js";
import {
  McpSkillExecutor,
  type McpConnectionRecord,
  type SkillDefinitionRecord,
} from "../../../src/modules/externalSkills/executor/mcpSkillExecutor.js";

const noopEmit = { emitStatus: async () => undefined, emitCustom: async () => undefined };
const connection: McpConnectionRecord = { id: "c1", serverUrl: "https://mock", authMethod: "access_token" };

const record = (over: Partial<SkillDefinitionRecord> = {}): SkillDefinitionRecord => ({
  id: "s1",
  agentId: "a1",
  skillName: "handoff_slack",
  connectionId: "c1",
  enabled: true,
  toolName: "post_message",
  boundParams: { channel: "#support" },
  exposedParams: { message: {} },
  ...over,
});

const buildExecutor = async (definition: SkillDefinitionRecord | null, tools: MockTool[]) => {
  const { clientTransport } = await connectMockMcpServer(tools);
  return new McpSkillExecutor({
    skills: {
      findEnabledByName: async (_agentId, name) =>
        definition && definition.skillName === name && definition.enabled ? definition : null,
    },
    connections: {
      findById: async (_agentId, id) => (id === connection.id ? connection : null),
    },
    toolServices: {
      create: () => new SdkMcpToolService({ transportFactory: () => clientTransport }),
    },
    toolSkillExecutorFactory: createToolSkillExecutor,
  });
};

const dispatch = (executor: McpSkillExecutor, skillName: string, collected: Record<string, unknown>, agentId = "a1") =>
  executor.dispatch({
    skill: { name: skillName },
    collected,
    context: agentId ? { agentId } : {},
    emit: noopEmit,
  });

describe("McpSkillExecutor", () => {
  it("resolves a defined skill, merges bound + exposed params, and returns a settled completed outcome", async () => {
    const executor = await buildExecutor(record(), [
      { name: "post_message", respond: (args) => ({ content: [{ type: "text", text: "posted" }], structuredContent: { echoed: args } }) },
    ]);

    const result = await dispatch(executor, "handoff_slack", { message: "hi" });
    expect(result.disposition).toBe("settled");
    if (result.disposition === "settled") {
      expect(result.outcome.status).toBe("completed");
      expect(result.outcome.outputs).toMatchObject({ echoed: { channel: "#support", message: "hi" } });
    }
  });

  it("fails safely for an undefined skill (the model cannot invoke arbitrary tools)", async () => {
    const executor = await buildExecutor(record(), [{ name: "post_message", respond: () => ({ content: [] }) }]);
    const result = await dispatch(executor, "unknown_skill", {});
    expect(result).toMatchObject({ disposition: "settled", outcome: { status: "failed", error: { code: "skill_not_found" } } });
  });

  it("fails safely for a disabled skill", async () => {
    const executor = await buildExecutor(record({ enabled: false }), [{ name: "post_message", respond: () => ({ content: [] }) }]);
    const result = await dispatch(executor, "handoff_slack", {});
    expect(result).toMatchObject({ disposition: "settled", outcome: { status: "failed", error: { code: "skill_not_found" } } });
  });

  it("maps a tool error to a settled failed outcome", async () => {
    const executor = await buildExecutor(record(), [
      { name: "post_message", respond: () => ({ content: [{ type: "text", text: "nope" }], isError: true }) },
    ]);
    const result = await dispatch(executor, "handoff_slack", { message: "hi" });
    expect(result).toMatchObject({ disposition: "settled", outcome: { status: "failed" } });
  });

  it("fails safely when the agent context is missing", async () => {
    const executor = await buildExecutor(record(), [{ name: "post_message", respond: () => ({ content: [] }) }]);
    const result = await dispatch(executor, "handoff_slack", {}, "");
    expect(result).toMatchObject({ disposition: "settled", outcome: { status: "failed", error: { code: "agent_context_missing" } } });
  });

  it("fails safely when the skill's connection is unavailable", async () => {
    const executor = await buildExecutor(record({ connectionId: "missing" }), [
      { name: "post_message", respond: () => ({ content: [] }) },
    ]);
    const result = await dispatch(executor, "handoff_slack", {});
    expect(result).toMatchObject({ disposition: "settled", outcome: { status: "failed", error: { code: "connection_unavailable" } } });
  });

  it("fails safely when the ToolService cannot be created (auth/secret resolution failure)", async () => {
    const executor = new McpSkillExecutor({
      skills: { findEnabledByName: async () => record() },
      connections: { findById: async () => connection },
      toolServices: {
        create: () => {
          throw new Error("missing credentials");
        },
      },
      toolSkillExecutorFactory: createToolSkillExecutor,
    });
    const result = await dispatch(executor, "handoff_slack", { message: "hi" });
    expect(result).toMatchObject({ disposition: "settled", outcome: { status: "failed", error: { code: "tool_service_unavailable" } } });
  });

  it("fills an exposed param from its slotBinding through the executor", async () => {
    const executor = await buildExecutor(record({ exposedParams: { message: { slotBinding: "userText" } } }), [
      { name: "post_message", respond: (args) => ({ content: [{ type: "text", text: "ok" }], structuredContent: { echoed: args } }) },
    ]);
    const result = await dispatch(executor, "handoff_slack", { userText: "from slot" });
    expect(result.disposition).toBe("settled");
    if (result.disposition === "settled") {
      expect(result.outcome.status).toBe("completed");
      expect(result.outcome.outputs).toMatchObject({ echoed: { channel: "#support", message: "from slot" } });
    }
  });

  it("fails safely when the runtime SSRF guard rejects the connection URL", async () => {
    const executor = new McpSkillExecutor({
      skills: { findEnabledByName: async () => record() },
      connections: { findById: async () => connection },
      toolServices: {
        create: (conn) =>
          new SdkMcpToolService({
            serverUrl: conn.serverUrl,
            assertPublicUrl: () => {
              throw new Error("non-public host");
            },
          }),
      },
      toolSkillExecutorFactory: createToolSkillExecutor,
    });
    const result = await dispatch(executor, "handoff_slack", { message: "hi" });
    expect(result).toMatchObject({ disposition: "settled", outcome: { status: "failed" } });
  });
});
