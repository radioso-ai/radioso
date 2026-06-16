import { describe, expect, it } from "vitest";

import { SkillExecutorRegistry } from "../../../src/modules/skills/public.js";
import { RoutineSkillExecutorDispatcher } from "../../../src/modules/routines/public.js";
import {
  WEBHOOK_SKILLS_ADAPTER,
  WebhookRoutineSkillResolver,
  WebhookSkillExecutor,
} from "../../../src/modules/webhookSkills/public.js";
import type { WebhookSkillDefinitionRecord } from "../../../src/db/repositories/webhookSkillDefinitionRepository.js";

const record: WebhookSkillDefinitionRecord = {
  id: "skill-1",
  workspaceId: "workspace-1",
  agentId: "agent-1",
  destinationId: "33333333-3333-4333-8333-333333333333",
  skillName: "send_lead_webhook",
  boundPayload: { source: "routine" },
  exposedPayload: { email: { slotBinding: "email", required: true } },
  enabled: true,
  createdAt: new Date("2026-06-16T00:00:00.000Z"),
  updatedAt: new Date("2026-06-16T00:00:00.000Z"),
};

describe("routine webhook skill dispatch", () => {
  it("routes authored webhook skills through the shared skill executor registry", async () => {
    const requests: unknown[] = [];
    const registry = new SkillExecutorRegistry();
    registry.register({
      kind: "internal",
      adapter: WEBHOOK_SKILLS_ADAPTER,
      executor: new WebhookSkillExecutor({
        skills: { findEnabledByName: async () => record },
        destinations: {
          resolve: async () => ({ url: "https://hooks.example.com/leads", secret: "receiver-secret" }),
          recordDeliveryOutcome: async () => undefined,
        },
        httpClient: { post: async (request) => void requests.push(request) },
      }),
    });
    const dispatcher = new RoutineSkillExecutorDispatcher(
      new WebhookRoutineSkillResolver([record.skillName]),
      registry,
      { workspaceId: "workspace-1" },
    );

    const result = await dispatcher.dispatch({
      skillName: record.skillName,
      state: {
        sessionId: "session-1",
        routineId: "routine-1",
        path: ["webhook_step"],
        variables: { email: "customer@example.com" },
        attempts: {},
        status: "active",
      },
      turn: {
        sessionId: "session-1",
        agent: { id: "agent-1" },
        inputEvent: { kind: "message", content: "send it" },
        history: [],
        stagedContext: [],
        steering: [],
      },
    });

    expect(result).toEqual({
      status: "delivered",
      outputs: {
        skillName: record.skillName,
        destinationId: record.destinationId,
      },
      answer: undefined,
    });
    expect(JSON.parse((requests[0] as { rawBody: string }).rawBody).source).toEqual({
      routineId: "routine-1",
      stepId: "webhook_step",
      sessionId: "session-1",
    });
  });
});
