import { describe, expect, it, vi } from "vitest";

import {
  ConversationAgentWebhookPermissionResolver,
  WebhookSendActionHandler,
  WEBHOOK_SEND_ACTION_TYPE,
  type WebhookSendHttpClient,
} from "../../src/modules/chat/services/actions/webhookSendActionHandler.js";
import type { ActionHandlerContext } from "../../src/modules/chat/services/actions/actionDispatcher.js";
import type { WebhookDestinationResolver } from "../../src/modules/webhooks/public.js";

const destinationId = "33333333-3333-4333-8333-333333333333";
const context: ActionHandlerContext = {
  requestId: "request_1",
  workspaceId: "ws_1",
  accountId: null,
  conversationId: "conv_1",
  idempotencyKey: "routine-action:conv_1:webhook.send:hash",
  attempt: 1,
  skillName: null,
};

const payload = {
  destinationRef: destinationId,
  source: {
    routineId: "routine_1",
    stepId: "terminal_complete",
    terminalKind: "complete",
    status: "completed",
    completionId: "completion_1",
  },
  data: {
    email: "alex@example.com",
    topic: "pricing",
  },
};

const resolver = (resolved: Awaited<ReturnType<WebhookDestinationResolver["resolve"]>>): WebhookDestinationResolver => ({
  resolve: vi.fn(async () => resolved),
});

const recordingHttpClient = (): { httpClient: WebhookSendHttpClient; requests: Parameters<WebhookSendHttpClient["post"]>[0][] } => {
  const requests: Parameters<WebhookSendHttpClient["post"]>[0][] = [];
  return {
    httpClient: {
      post: vi.fn(async (request) => {
        requests.push(request);
      }),
    },
    requests,
  };
};

const deliveryOutcomes = () => ({
  recordDeliveryOutcome: vi.fn(async () => {}),
});

const telemetry = () => ({
  emit: vi.fn(async () => null),
});

describe("WebhookSendActionHandler", () => {
  it("posts signed routine completion payloads to the resolved destination", async () => {
    const destinations = resolver({ url: "https://hooks.example.com/routine", secret: "receiver-secret" });
    const { httpClient, requests } = recordingHttpClient();
    const outcomes = deliveryOutcomes();
    const handler = new WebhookSendActionHandler({
      destinations,
      permission: { canSend: vi.fn(async () => ({ allowed: true as const })) },
      httpClient,
      deliveryOutcomes: outcomes,
    });

    await handler.handle({ payload, context });

    expect(destinations.resolve).toHaveBeenCalledWith(destinationId, { workspaceId: "ws_1" });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://hooks.example.com/routine");
    expect(requests[0]!.headers["Idempotency-Key"]).toBe("routine-action:conv_1:webhook.send:hash");
    expect(requests[0]!.headers["X-Radioso-Timestamp"]).toEqual(expect.any(String));
    expect(requests[0]!.headers["X-Radioso-Signature"]).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(JSON.parse(requests[0]!.rawBody)).toEqual({
      type: "routine.completion",
      workspaceId: "ws_1",
      conversationId: "conv_1",
      requestId: "request_1",
      source: payload.source,
      data: payload.data,
    });
    expect(outcomes.recordDeliveryOutcome).toHaveBeenCalledWith("ws_1", destinationId, "success");
  });

  it("emits delivery telemetry without payloads, URLs, or secrets", async () => {
    const { httpClient } = recordingHttpClient();
    const telemetryService = telemetry();
    const handler = new WebhookSendActionHandler({
      destinations: resolver({ url: "https://hooks.example.com/routine", secret: "receiver-secret" }),
      permission: { canSend: vi.fn(async () => ({ allowed: true as const })) },
      httpClient,
      telemetryService,
    });

    await handler.handle({ payload, context });

    expect(telemetryService.emit).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "webhook.send.delivery.completed",
      severity: "info",
      correlation: {
        workspaceId: "ws_1",
        conversationId: "conv_1",
        requestId: "request_1",
      },
      metrics: { attempt: 1, deliveryAttempt: 1 },
      metadata: {
        destinationRef: destinationId,
        routineId: "routine_1",
        stepId: "terminal_complete",
      },
      tags: {
        outcome: "success",
        reason: "none",
        terminal_kind: "complete",
      },
    }));
    expect(JSON.stringify(telemetryService.emit.mock.calls)).not.toContain("alex@example.com");
    expect(JSON.stringify(telemetryService.emit.mock.calls)).not.toContain("receiver-secret");
    expect(JSON.stringify(telemetryService.emit.mock.calls)).not.toContain("hooks.example.com");
  });

  it("terminally skips without retry when the destination cannot be resolved", async () => {
    const { httpClient, requests } = recordingHttpClient();
    const warn = vi.fn();
    const outcomes = deliveryOutcomes();
    const handler = new WebhookSendActionHandler({
      destinations: resolver(null),
      permission: { canSend: vi.fn(async () => ({ allowed: true as const })) },
      httpClient,
      logger: { warn },
      deliveryOutcomes: outcomes,
    });

    await handler.handle({ payload, context });

    expect(requests).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "destination_not_found",
        destinationRef: destinationId,
        workspaceId: "ws_1",
        conversationId: "conv_1",
      }),
      expect.stringContaining("skipped"),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("alex@example.com");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("receiver-secret");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("hooks.example.com");
    expect(outcomes.recordDeliveryOutcome).toHaveBeenCalledWith("ws_1", destinationId, "skipped");
  });

  it("terminally skips without retry when the agent webhook capability is disabled", async () => {
    const destinations = resolver({ url: "https://hooks.example.com/routine", secret: "receiver-secret" });
    const { httpClient, requests } = recordingHttpClient();
    const warn = vi.fn();
    const outcomes = deliveryOutcomes();
    const handler = new WebhookSendActionHandler({
      destinations,
      permission: { canSend: vi.fn(async () => ({ allowed: false as const, reason: "capability_disabled" as const })) },
      httpClient,
      logger: { warn },
      deliveryOutcomes: outcomes,
    });

    await handler.handle({ payload, context });

    expect(destinations.resolve).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "capability_disabled",
        workspaceId: "ws_1",
        conversationId: "conv_1",
      }),
      expect.stringContaining("skipped"),
    );
    expect(outcomes.recordDeliveryOutcome).toHaveBeenCalledWith("ws_1", destinationId, "skipped");
  });

  it("emits skipped delivery telemetry with the skip reason", async () => {
    const telemetryService = telemetry();
    const handler = new WebhookSendActionHandler({
      destinations: resolver({ url: "https://hooks.example.com/routine", secret: "receiver-secret" }),
      permission: { canSend: vi.fn(async () => ({ allowed: false as const, reason: "capability_disabled" as const })) },
      httpClient: recordingHttpClient().httpClient,
      telemetryService,
    });

    await handler.handle({ payload, context });

    expect(telemetryService.emit).toHaveBeenCalledWith(expect.objectContaining({
      severity: "warn",
      tags: {
        outcome: "skipped",
        reason: "capability_disabled",
        terminal_kind: "complete",
      },
      metadata: {
        destinationRef: destinationId,
        routineId: "routine_1",
        stepId: "terminal_complete",
      },
    }));
  });

  it("throws transport failures so the action dispatcher retries them", async () => {
    const handler = new WebhookSendActionHandler({
      destinations: resolver({ url: "https://hooks.example.com/routine", secret: "receiver-secret" }),
      permission: { canSend: vi.fn(async () => ({ allowed: true as const })) },
      httpClient: {
        post: vi.fn(async () => {
          throw new Error("receiver unavailable");
        }),
      },
    });

    await expect(handler.handle({ payload, context })).rejects.toThrow("receiver unavailable");
  });

  it("records retry and failed outcomes after dispatcher failure classification", async () => {
    const outcomes = deliveryOutcomes();
    const telemetryService = telemetry();
    const handler = new WebhookSendActionHandler({
      destinations: resolver({ url: "https://hooks.example.com/routine", secret: "receiver-secret" }),
      permission: { canSend: vi.fn(async () => ({ allowed: true as const })) },
      httpClient: { post: vi.fn(async () => {}) },
      deliveryOutcomes: outcomes,
      telemetryService,
    });

    await handler.recordFailureOutcome?.({
      payload,
      context,
      outcome: "retry",
      error: "receiver unavailable",
    });
    await handler.recordFailureOutcome?.({
      payload,
      context,
      outcome: "failed",
      error: "receiver unavailable",
    });

    expect(outcomes.recordDeliveryOutcome).toHaveBeenNthCalledWith(1, "ws_1", destinationId, "retry");
    expect(outcomes.recordDeliveryOutcome).toHaveBeenNthCalledWith(2, "ws_1", destinationId, "failed");
    expect(telemetryService.emit).toHaveBeenNthCalledWith(1, expect.objectContaining({
      severity: "warn",
      tags: {
        outcome: "retry",
        reason: "handler_error",
        terminal_kind: "complete",
      },
    }));
    expect(telemetryService.emit).toHaveBeenNthCalledWith(2, expect.objectContaining({
      severity: "error",
      tags: {
        outcome: "failed",
        reason: "handler_error",
        terminal_kind: "complete",
      },
    }));
  });

  it("exports the generic action type", () => {
    expect(WEBHOOK_SEND_ACTION_TYPE).toBe("webhook.send");
  });
});

describe("ConversationAgentWebhookPermissionResolver", () => {
  it("allows only conversations whose agent has webhook exports enabled", async () => {
    const conversations = {
      findByIdAndWorkspaceId: vi.fn(async () => ({ agentId: "agent_1" })),
    };
    const agents = {
      findByIdAndWorkspaceId: vi.fn(async () => ({ webhookExportsEnabled: true })),
    };

    const resolver = new ConversationAgentWebhookPermissionResolver(conversations, agents);

    await expect(resolver.canSend(context)).resolves.toEqual({ allowed: true });
    expect(conversations.findByIdAndWorkspaceId).toHaveBeenCalledWith("conv_1", "ws_1");
    expect(agents.findByIdAndWorkspaceId).toHaveBeenCalledWith("agent_1", "ws_1");
  });

  it("denies terminally when context, conversation, agent, or flag is missing", async () => {
    const missingConversation = new ConversationAgentWebhookPermissionResolver(
      { findByIdAndWorkspaceId: vi.fn(async () => null) },
      { findByIdAndWorkspaceId: vi.fn(async () => ({ webhookExportsEnabled: true })) },
    );
    const disabled = new ConversationAgentWebhookPermissionResolver(
      { findByIdAndWorkspaceId: vi.fn(async () => ({ agentId: "agent_1" })) },
      { findByIdAndWorkspaceId: vi.fn(async () => ({ webhookExportsEnabled: false })) },
    );

    await expect(missingConversation.canSend(context)).resolves.toEqual({
      allowed: false,
      reason: "agent_not_resolved",
    });
    await expect(disabled.canSend(context)).resolves.toEqual({
      allowed: false,
      reason: "capability_disabled",
    });
    await expect(disabled.canSend({ ...context, workspaceId: null })).resolves.toEqual({
      allowed: false,
      reason: "missing_context",
    });
  });

  it("prefers the completion_export webhook skill gate over the legacy agent flag", async () => {
    const conversations = {
      findByIdAndWorkspaceId: vi.fn(async () => ({ agentId: "agent_1" })),
    };
    const agents = {
      findByIdAndWorkspaceId: vi.fn(async () => ({ webhookExportsEnabled: false })),
    };
    const skills = {
      findByName: vi.fn(async () => ({ kind: "webhook", enabled: true, targetId: "dest_1" })),
    };

    const resolver = new ConversationAgentWebhookPermissionResolver(conversations, agents, skills);

    await expect(resolver.canSend(context)).resolves.toEqual({ allowed: true });
    expect(skills.findByName).toHaveBeenCalledWith("ws_1", "agent_1", "completion_export");
  });
});
