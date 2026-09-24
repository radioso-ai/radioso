import { describe, expect, it, vi } from "vitest";

import { createAgentToolCatalog } from "../../../src/modules/routines/exposure/agentToolCatalog.js";
import type { RoutineDefinition } from "../../../src/modules/routines/public.js";

const FIXED_DATE = new Date("2026-01-01T00:00:00.000Z");

const routine = (overrides: Partial<RoutineDefinition> & Pick<RoutineDefinition, "id" | "name">): RoutineDefinition => ({
  agentId: "agent-1",
  lineageId: `lineage:${overrides.id}`,
  version: 1,
  enabled: true,
  createdAt: FIXED_DATE,
  updatedAt: FIXED_DATE,
  activation: { triggerDescription: "when asked", gateRef: null, priority: 10, reentryMode: "once_per_conversation" },
  slots: [],
  steps: [{ stableStepId: "ask", kind: "chat", instruction: "Ask.", toolRef: null, actionType: null, ordinal: 0, metadata: {} }],
  transitions: [],
  terminals: [{ stableStepId: "done", kind: "complete", instruction: null, ordinal: 0 }],
  ...overrides,
});

const exposed = (toolName: string, description = `Runs ${toolName}.`): RoutineDefinition["exposure"] => ({
  enabled: true,
  toolName,
  description,
});

describe("createAgentToolCatalog", () => {
  it("lists one descriptor per published, enabled routine whose exposure is enabled, with the agent's name", async () => {
    const listPublished = vi.fn(async () => [
      routine({
        id: "r-return",
        name: "Start a return",
        exposure: exposed("start_return", "Start a return for an order."),
        slots: [{ stableSlotId: "s1", key: "orderId", type: "text", required: true, description: "The order number", ordinal: 0 }],
      }),
      routine({ id: "r-parked", name: "Parked", enabled: false, exposure: exposed("parked_tool") }),
      routine({ id: "r-hidden", name: "Hidden", exposure: { enabled: false, toolName: "hidden_tool", description: "" } }),
      routine({ id: "r-plain", name: "No exposure" }),
    ]);
    const catalog = createAgentToolCatalog({
      agents: { find: async () => ({ name: "Acme Support", description: null }) },
      publishedRoutines: { listPublished },
    });

    const loaded = await catalog.load({ workspaceId: "ws-1", agentId: "agent-1", agentRevisionId: "rev-7" });

    expect(listPublished).toHaveBeenCalledWith({ workspaceId: "ws-1", agentId: "agent-1", agentRevisionId: "rev-7" });
    expect(loaded).toEqual({
      agent: { name: "Acme Support", description: null },
      tools: [
        {
          toolName: "start_return",
          description: "Start a return for an order.",
          routineLineageId: "lineage:r-return",
          inputSchema: {
            type: "object",
            properties: { orderId: { type: "string", description: "The order number" } },
            required: ["orderId"],
            additionalProperties: false,
          },
        },
      ],
      // Composed here, not in the MCP package: the package reads generated types and must not
      // learn what an agent description is made of. See askAgentDescription.ts for the shape.
      askAgentDescription: expect.stringContaining("start_return") as unknown as string,
    });
  });

  it("returns an empty tool list when nothing published is exposed", async () => {
    const catalog = createAgentToolCatalog({
      agents: { find: async () => ({ name: "Acme Support", description: null }) },
      publishedRoutines: { listPublished: async () => [routine({ id: "r-plain", name: "No exposure" })] },
    });

    const loaded = await catalog.load({ workspaceId: "ws-1", agentId: "agent-1" });

    expect(loaded.tools).toEqual([]);
  });

  it("refuses to describe an agent the reader cannot find", async () => {
    const catalog = createAgentToolCatalog({
      agents: { find: async () => null },
      publishedRoutines: { listPublished: async () => [] },
    });

    await expect(catalog.load({ workspaceId: "ws-1", agentId: "missing" })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
