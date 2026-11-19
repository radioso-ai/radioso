import { describe, expect, it, vi } from "vitest";

import { operatorMcpDispositions } from "../../../src/modules/operatorCopilot/operatorMcpDisposition.js";
import { createEventSubscriptionsCopilotTools } from "../../../src/modules/operatorCopilot/tools/eventSubscriptions.js";
import type { EventSubscriptionView } from "../../../src/modules/workspaceEventLog/public.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

const context = {
  workspaceId: WORKSPACE_ID,
  accountId: "account-1",
  operatorUserId: "operator-1",
  surface: "dashboard" as const,
  currentAuthorization: { hasAllPermissions: vi.fn(async () => true) },
  pageContext: { view: "other" as const, agentId: null, conversationId: null, selection: null, entities: [] },
};

const stopped: EventSubscriptionView = {
  id: "22222222-2222-4222-8222-222222222222",
  label: "zapier",
  targetHost: "hooks.zapier.example",
  eventTypes: ["routine.completed"],
  status: "disabled",
  disabledReason: "creator_revoked",
  createdAt: "2026-11-18T09:00:00.000Z",
  createdBy: { kind: "teammate", label: "Ada Example" },
  lastDelivery: { at: "2026-11-19T08:30:00.000Z", outcome: "failed", statusCode: 502 },
  failingSince: "2026-11-19T08:00:00.000Z",
};

describe("list_event_subscriptions", () => {
  const setup = (subscriptions: readonly EventSubscriptionView[]) => {
    const list = vi.fn(async () => subscriptions);
    const [descriptor] = createEventSubscriptionsCopilotTools({ eventSubscriptions: { list } });
    return { descriptor, list };
  };

  it("is a read tool gated on the permission of the route it mirrors, and an eligible Operator MCP read", () => {
    const { descriptor } = setup([]);
    expect(descriptor).toMatchObject({ name: "list_event_subscriptions", shape: "read", requiredPermissions: ["workspace.event_subscriptions.manage"] });
    expect(operatorMcpDispositions.list_event_subscriptions).toMatchObject({ status: "eligible", scope: "operator:read" });
  });

  it("tells an operator why an automation stopped, naming its creator by kind only", async () => {
    const { descriptor, list } = setup([stopped]);

    const output = await descriptor.createTool(context).invoke({}, {} as never);

    expect(list).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(output).toEqual({
      subscriptions: [{
        id: stopped.id,
        label: "zapier",
        targetHost: "hooks.zapier.example",
        eventTypes: ["routine.completed"],
        status: "disabled",
        disabledReason: "creator_revoked",
        createdAt: stopped.createdAt,
        createdBy: { kind: "teammate" },
        lastDelivery: stopped.lastDelivery,
        failingSince: stopped.failingSince,
      }],
    });
    expect(() => descriptor.outputSchema.parse(output)).not.toThrow();
  });

  it("passes through only the fields it names, whatever else the view grows", async () => {
    const grown = { ...stopped, targetUrl: "https://hooks.zapier.example/hooks/a-bearer-path" } as EventSubscriptionView;
    const { descriptor } = setup([grown]);

    const output = await descriptor.createTool(context).invoke({}, {} as never);

    expect(JSON.stringify(output)).not.toContain("a-bearer-path");
    expect(JSON.stringify(output)).not.toContain("Ada Example");
  });
});
