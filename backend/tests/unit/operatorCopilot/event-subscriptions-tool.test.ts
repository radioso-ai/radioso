import { describe, expect, it, vi } from "vitest";

import { operatorMcpDispositions } from "../../../src/modules/operatorCopilot/operatorMcpDisposition.js";
import { createEventSubscriptionsCopilotTools } from "../../../src/modules/operatorCopilot/tools/eventSubscriptions.js";
import { EventSubscriptionService } from "../../../src/modules/workspaceEventLog/public.js";
import { InMemoryWorkspaceEventSubscriptionStore, taggingSealer } from "../../support/inMemoryWorkspaceEventSubscriptions.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

const context = {
  workspaceId: WORKSPACE_ID,
  accountId: "account-1",
  operatorUserId: "operator-1",
  surface: "dashboard" as const,
  currentAuthorization: { hasAllPermissions: vi.fn(async () => true) },
  pageContext: { view: "other" as const, agentId: null, conversationId: null, selection: null, entities: [] },
};

describe("list_event_subscriptions", () => {
  const setup = async () => {
    const store = new InMemoryWorkspaceEventSubscriptionStore();
    const service = new EventSubscriptionService({
      store,
      sealer: taggingSealer,
      audit: { record: async () => undefined },
      assertPublicUrl: async () => undefined,
      allowHttpLoopback: false,
    });
    const created = await service.create({
      workspaceId: WORKSPACE_ID,
      actor: { accountId: "account-1" },
      createdBy: { kind: "service_account", credentialId: "credential-1", serviceAccountId: "service-1" },
      targetUrl: "https://hooks.zapier.example/hooks/standard/1/a-bearer-path",
      eventTypes: ["routine.completed"],
      label: "zapier",
      readableTypes: ["routine.completed"],
    });
    await store.disable({ workspaceId: WORKSPACE_ID, subscriptionId: created.subscription.id, reason: "creator_revoked", at: new Date() });
    const [descriptor] = createEventSubscriptionsCopilotTools({ eventSubscriptions: service });
    return { descriptor, created };
  };

  it("is a read tool gated on the permission of the route it mirrors, and an eligible Operator MCP read", async () => {
    const { descriptor } = await setup();
    expect(descriptor).toMatchObject({ name: "list_event_subscriptions", shape: "read", requiredPermissions: ["workspace.event_subscriptions.manage"] });
    expect(operatorMcpDispositions.list_event_subscriptions).toMatchObject({ status: "eligible", scope: "operator:read" });
  });

  it("tells an operator why an automation stopped, without the target URL or the secret", async () => {
    const { descriptor, created } = await setup();

    const output = descriptor.outputSchema.parse(await descriptor.createTool(context).invoke({}, {} as never));

    expect(output).toEqual({
      subscriptions: [expect.objectContaining({
        id: created.subscription.id,
        label: "zapier",
        targetHost: "hooks.zapier.example",
        status: "disabled",
        disabledReason: "creator_revoked",
      })],
    });
    expect(JSON.stringify(output)).not.toContain("a-bearer-path");
    expect(JSON.stringify(output)).not.toContain(created.signingSecret);
  });
});
