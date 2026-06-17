import { describe, expect, it, vi } from "vitest";

import { WebhookSkillExecutor } from "../../../src/modules/webhookSkills/public.js";
import type { WebhookSkillDefinitionRecord } from "../../../src/db/repositories/webhookSkillDefinitionRepository.js";

const noopEmit = { emitStatus: async () => undefined, emitCustom: async () => undefined };

const definition = (overrides: Partial<WebhookSkillDefinitionRecord> = {}): WebhookSkillDefinitionRecord => ({
  id: "skill-1",
  workspaceId: "workspace-1",
  agentId: "agent-1",
  destinationId: "33333333-3333-4333-8333-333333333333",
  skillName: "send_lead_webhook",
  boundPayload: { source: "routine" },
  exposedPayload: {
    email: { slotBinding: "customerEmail", required: true },
    topic: { required: false },
  },
  enabled: true,
  createdAt: new Date("2026-06-16T00:00:00.000Z"),
  updatedAt: new Date("2026-06-16T00:00:00.000Z"),
  ...overrides,
});

const dispatch = (
  executor: WebhookSkillExecutor,
  collected: Record<string, unknown> = { customerEmail: "customer@example.com" },
) =>
  executor.dispatch({
    skill: { name: "send_lead_webhook" },
    collected,
    context: {
      agentId: "agent-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      routineId: "routine-1",
      stepId: "webhook_step",
    },
    emit: noopEmit,
  });

describe("WebhookSkillExecutor", () => {
  it("posts a signed payload built from bound and exposed fields", async () => {
    const requests: unknown[] = [];
    const outcomes: unknown[] = [];
    const executor = new WebhookSkillExecutor({
      skills: { findEnabledByName: async () => definition() },
      destinations: {
        resolve: async () => ({ url: "https://hooks.example.com/leads", secret: "receiver-secret" }),
        recordDeliveryOutcome: async (...args) => {
          outcomes.push(args);
        },
      },
      httpClient: {
        post: vi.fn(async (request) => {
          requests.push(request);
        }),
      },
    });

    const result = await dispatch(executor);

    expect(result).toMatchObject({
      disposition: "settled",
      outcome: {
        status: "delivered",
        outputs: {
          skillName: "send_lead_webhook",
          destinationId: "33333333-3333-4333-8333-333333333333",
        },
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "https://hooks.example.com/leads",
      headers: {
        "X-Radioso-Timestamp": expect.any(String),
        "X-Radioso-Signature": expect.stringMatching(/^sha256=[a-f0-9]{64}$/),
      },
    });
    expect(JSON.parse((requests[0] as { rawBody: string }).rawBody)).toEqual({
      type: "agent.webhook_skill",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      skillName: "send_lead_webhook",
      source: {
        routineId: "routine-1",
        stepId: "webhook_step",
        sessionId: "session-1",
      },
      data: {
        source: "routine",
        email: "customer@example.com",
      },
    });
    expect(outcomes).toEqual([["workspace-1", "33333333-3333-4333-8333-333333333333", "success"]]);
  });

  it("returns missing_input without sending when a required exposed value is absent", async () => {
    const requests: unknown[] = [];
    const executor = new WebhookSkillExecutor({
      skills: { findEnabledByName: async () => definition() },
      destinations: {
        resolve: async () => ({ url: "https://hooks.example.com/leads", secret: "receiver-secret" }),
        recordDeliveryOutcome: async () => undefined,
      },
      httpClient: { post: async (request) => void requests.push(request) },
    });

    const result = await dispatch(executor, {});

    expect(result).toMatchObject({
      disposition: "settled",
      outcome: { status: "missing_input", outputs: { missingInputs: ["customerEmail"] } },
    });
    expect(requests).toHaveLength(0);
  });

  it("fails closed for undefined or disabled skill names", async () => {
    const executor = new WebhookSkillExecutor({
      skills: { findEnabledByName: async () => null },
      destinations: { resolve: async () => null },
      httpClient: { post: async () => undefined },
    });

    const result = await dispatch(executor);

    expect(result).toMatchObject({
      disposition: "settled",
      outcome: { status: "failed", outputs: { reason: "skill_not_found" } },
    });
  });

  it("logs a sanitized warning when delivery fails", async () => {
    const warn = vi.fn();
    const executor = new WebhookSkillExecutor({
      skills: { findEnabledByName: async () => definition() },
      destinations: {
        resolve: async () => ({ url: "https://hooks.example.com/leads", secret: "receiver-secret" }),
        recordDeliveryOutcome: async () => undefined,
      },
      httpClient: {
        post: vi.fn(async () => {
          throw new Error("Webhook POST failed with status 500");
        }),
      },
      logger: { warn },
    });

    const result = await dispatch(executor);

    expect(result).toMatchObject({
      disposition: "settled",
      outcome: { status: "failed", outputs: { reason: "delivery_failed" } },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "webhook_skill_delivery_failed",
        workspaceId: "workspace-1",
        agentId: "agent-1",
        destinationId: "33333333-3333-4333-8333-333333333333",
        skillName: "send_lead_webhook",
        errorName: "Error",
        errorMessage: "Webhook POST failed with status 500",
      }),
      "Webhook skill delivery failed",
    );
    expect(JSON.stringify(warn.mock.calls[0]?.[0])).not.toContain("receiver-secret");
  });
});
