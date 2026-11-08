import { describe, expect, it, vi } from "vitest";

import { filterCopilotToolCatalog } from "../../../src/modules/operatorCopilot/catalog.js";
import { OperatorMcpCatalogService } from "../../../src/modules/operatorCopilot/mcpCatalog.js";
import { operatorMcpToolSchemas } from "../../../src/modules/operatorCopilot/mcpToolSchema.js";
import { operatorMcpDispositions } from "../../../src/modules/operatorCopilot/operatorMcpDisposition.js";
import { NotificationDeliveryReader, type NotificationDeliveryRecord } from "../../../src/modules/operatorNotifications/public.js";
import {
  createNotificationDeliveriesCopilotTools,
  type CopilotNotificationDeliveriesPort,
} from "../../../src/modules/operatorCopilot/tools/notificationDeliveries.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_AGENT_ID = "55555555-5555-4555-8555-555555555555";
const DUPLICATE_AGENT_ID = "66666666-6666-4666-8666-666666666666";

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
  const listExisting = vi.fn(async () => [
    { id: AGENT_ID, name: "Support" },
    { id: OTHER_AGENT_ID, name: "Billing" },
    { id: DUPLICATE_AGENT_ID, name: "Billing" },
  ] as never);
  const [descriptor] = createNotificationDeliveriesCopilotTools({
    agentService: { get, listExisting },
    notificationDeliveries: { list },
  });
  const invoke = async (input: unknown, agentId: string | null = null) => {
    const parsed = descriptor.inputSchema.parse(input);
    return descriptor.outputSchema.parse(await descriptor.createTool(context(agentId)).invoke(parsed, {} as never));
  };
  return { descriptor, invoke, list, get, listExisting };
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

describe("list_notification_deliveries over operator MCP", () => {
  const mcpContext = {
    workspaceId: WORKSPACE_ID,
    accountId: "account-1",
    operatorUserId: "operator-1",
    surface: "mcp" as const,
    currentAuthorization: { hasAllPermissions: vi.fn(async () => true) },
    // A stateless transport has no page and so no selected agent.
    pageContext: { view: null, agentId: null, conversationId: null, selection: null, entities: [] },
  };
  const callThroughMcp = (args: unknown, tool = setup()) => {
    const catalog = new OperatorMcpCatalogService([{ ...tool.descriptor, mcpDisposition: operatorMcpDispositions.list_notification_deliveries }]);
    return {
      ...tool,
      result: () => catalog.invoke({
        name: "list_notification_deliveries",
        arguments: args,
        context: mcpContext,
        scopes: new Set(["operator:read"]),
        signal: AbortSignal.timeout(1_000),
      }),
    };
  };

  it("narrows to the agent a name resolves to, as Ray does", async () => {
    const call = callThroughMcp({ agentName: " support " });

    await call.result();

    expect(call.list).toHaveBeenCalledWith(WORKSPACE_ID, expect.objectContaining({ agentId: AGENT_ID }));
    expect(call.get).toHaveBeenCalledWith(WORKSPACE_ID, AGENT_ID);
  });

  it("refuses a name that matches no agent instead of listing every agent's notices", async () => {
    const call = callThroughMcp({ agentName: "Nonexistent" });

    await expect(call.result()).rejects.toMatchObject({ statusCode: 400 });
    expect(call.list).not.toHaveBeenCalled();
  });

  it("refuses a name that matches several agents instead of picking one", async () => {
    const call = callThroughMcp({ agentName: "Billing" });

    await expect(call.result()).rejects.toMatchObject({ statusCode: 400 });
    expect(call.list).not.toHaveBeenCalled();
  });

  it("reads the whole workspace only when neither an id nor a name is given", async () => {
    const call = callThroughMcp({});

    await call.result();

    expect(call.list).toHaveBeenCalledWith(WORKSPACE_ID, expect.objectContaining({ agentId: undefined }));
  });
});

describe("list_notification_deliveries paging", () => {
  const rowAt = (n: number): NotificationDeliveryRecord => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    agentId: AGENT_ID,
    conversationId: CONVERSATION_ID,
    kind: "completion",
    // Long enough that a page of them would be cut by a string cap if the cap were ever the bound.
    recipientEmail: `${"a".repeat(60)}-${n}@example.com`,
    outcome: "sent",
    createdAt: new Date(Date.UTC(2026, 10, 7, 12, 0, 0) - n * 1_000),
    updatedAt: new Date(Date.UTC(2026, 10, 7, 12, 0, 0) - n * 1_000),
  });

  it("holds a page to what the result keeps, so no row falls between two pages", async () => {
    const all = Array.from({ length: 95 }, (_, index) => rowAt(index + 1));
    const reader = new NotificationDeliveryReader({
      list: async (_workspaceId, query) => all
        .filter((row) => query.after === null
          || row.createdAt < query.after.createdAt
          || (row.createdAt.getTime() === query.after.createdAt.getTime() && row.id < query.after.id))
        .slice(0, query.limit),
    });
    const [descriptor] = createNotificationDeliveriesCopilotTools({
      agentService: { get: vi.fn(async () => ({})) },
      notificationDeliveries: reader,
    });
    expect(() => descriptor.inputSchema.parse({ limit: 41 })).toThrow();

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const output = outputOf(await descriptor.createTool(context(null)).invoke(descriptor.inputSchema.parse({ limit: 40, cursor }), {} as never));
      expect(output.items.length).toBeLessThanOrEqual(40);
      seen.push(...output.items.map((item) => item.id));
      if (!output.nextCursor) break;
      cursor = output.nextCursor;
    }

    expect(seen).toEqual(all.map((row) => row.id));
  });
});

const outputOf = (value: unknown) => value as { items: Array<{ id: string }>; nextCursor: string | null; truncation?: unknown };

