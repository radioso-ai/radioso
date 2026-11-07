import { describe, expect, it, vi } from "vitest";

import { filterCopilotToolCatalog } from "../../../src/modules/operatorCopilot/catalog.js";
import { operatorMcpToolSchemas } from "../../../src/modules/operatorCopilot/mcpToolSchema.js";
import {
  createNotificationDeliveriesCopilotTools,
  type CopilotNotificationDeliveriesPort,
} from "../../../src/modules/operatorCopilot/tools/notificationDeliveries.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";

const context = (agentId: string | null) => ({
  workspaceId: WORKSPACE_ID,
  accountId: "account-1",
  operatorUserId: "operator-1",
  surface: "dashboard" as const,
  currentAuthorization: { hasAllPermissions: vi.fn(async () => true) },
  pageContext: { view: "other" as const, agentId, conversationId: null, selection: null, entities: [] },
});

const setup = () => {
  const list = vi.fn<CopilotNotificationDeliveriesPort["list"]>(async () => ({
    items: [{
      id: "44444444-4444-4444-8444-444444444444",
      agentId: AGENT_ID,
      conversationId: CONVERSATION_ID,
      kind: "handoff" as const,
      recipientEmail: "front-desk@example.com",
      outcome: "skipped_unconfirmed" as const,
      createdAt: new Date("2026-11-07T10:00:00.000Z"),
      updatedAt: new Date("2026-11-07T10:00:05.000Z"),
    }],
    nextCursor: "next-page",
  }));
  const get = vi.fn(async () => ({}));
  const [descriptor] = createNotificationDeliveriesCopilotTools({
    agentService: { get },
    notificationDeliveries: { list },
  });
  const invoke = async (input: unknown, agentId: string | null = null) => {
    const parsed = descriptor.inputSchema.parse(input);
    return descriptor.outputSchema.parse(await descriptor.createTool(context(agentId)).invoke(parsed, {} as never));
  };
  return { descriptor, invoke, list, get };
};

describe("list_notification_deliveries", () => {
  it("is a read tool gated on the permission of the route it mirrors", () => {
    const { descriptor } = setup();

    expect(descriptor).toMatchObject({ name: "list_notification_deliveries", shape: "read", requiredPermissions: ["workspace.agents.read"] });
    expect(descriptor.verificationCost({})).toBe(0);
    expect(filterCopilotToolCatalog([descriptor], new Set(["workspace.agents.read"])).map(({ name }) => name)).toEqual(["list_notification_deliveries"]);
    expect(filterCopilotToolCatalog([descriptor], new Set(["workspace.history.read"]))).toEqual([]);
  });

  it("advertises object-rooted schemas and a description well under the MCP cap", () => {
    const { descriptor } = setup();
    const { inputSchema, outputSchema } = operatorMcpToolSchemas(descriptor);

    expect(inputSchema.type).toBe("object");
    expect(outputSchema.type).toBe("object");
    expect(descriptor.description.length).toBeLessThan(2_048);
    expect(JSON.stringify(outputSchema)).not.toContain("\"exclusiveMinimum\":true");
  });

  it("maps a page of the log, with times as text and the cursor to continue", async () => {
    const { invoke, list } = setup();

    const output = await invoke({ outcome: "skipped_unconfirmed", limit: 10 });

    expect(output).toEqual({
      items: [{
        id: "44444444-4444-4444-8444-444444444444",
        agentId: AGENT_ID,
        conversationId: CONVERSATION_ID,
        kind: "handoff",
        recipientEmail: "front-desk@example.com",
        outcome: "skipped_unconfirmed",
        createdAt: "2026-11-07T10:00:00.000Z",
        updatedAt: "2026-11-07T10:00:05.000Z",
      }],
      nextCursor: "next-page",
    });
    expect(list).toHaveBeenCalledWith(WORKSPACE_ID, { agentId: undefined, outcome: "skipped_unconfirmed", cursor: undefined, limit: 10 });
  });

  it("reads the whole workspace unless an agent is named or selected, and bounds the page by default", async () => {
    const { invoke, list, get } = setup();

    await invoke({});
    expect(list).toHaveBeenLastCalledWith(WORKSPACE_ID, expect.objectContaining({ agentId: undefined, limit: 25 }));
    expect(get).not.toHaveBeenCalled();

    await invoke({ agentId: AGENT_ID, cursor: "page-2" });
    expect(get).toHaveBeenLastCalledWith(WORKSPACE_ID, AGENT_ID);
    expect(list).toHaveBeenLastCalledWith(WORKSPACE_ID, expect.objectContaining({ agentId: AGENT_ID, cursor: "page-2" }));

    await invoke({}, AGENT_ID);
    expect(list).toHaveBeenLastCalledWith(WORKSPACE_ID, expect.objectContaining({ agentId: AGENT_ID }));
  });

  it("refuses an input it does not know and a page larger than the cap", () => {
    const { descriptor } = setup();

    expect(() => descriptor.inputSchema.parse({ workspaceId: WORKSPACE_ID })).toThrow();
    expect(() => descriptor.inputSchema.parse({ limit: 51 })).toThrow();
    expect(() => descriptor.inputSchema.parse({ outcome: "delivered" })).toThrow();
  });
});
