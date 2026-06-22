import { describe, expect, it, vi } from "vitest";

import { NotifyExecutor } from "../../src/modules/notify/notifyExecutor.js";

const skill = {
  id: "skill_1",
  workspaceId: "ws_1",
  agentId: "agent_1",
  skillName: "contact_human",
  kind: "notify" as const,
  targetType: "notify_delivery",
  targetId: null,
  config: {},
  invocationMode: "routine_named" as const,
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("NotifyExecutor", () => {
  it("enqueues the existing contact.send action and returns a structured delivered outcome", async () => {
    const enqueue = vi.fn(async () => ({ id: "action_1", duplicate: false }));
    const executor = new NotifyExecutor({
      skills: { findByName: async () => skill },
      outbox: { enqueue },
    });

    const result = await executor.dispatch({
      skill: { name: "contact_human" },
      collected: { message: "Please call me", email: "visitor@example.com" },
      context: {
        workspaceId: "ws_1",
        agentId: "agent_1",
        conversationId: "conv_1",
        requestId: "req_1",
      },
      emit: { emitStatus: async () => undefined, emitCustom: async () => undefined },
    });

    expect(result).toMatchObject({
      disposition: "settled",
      outcome: { status: "delivered" },
    });
    expect(enqueue).toHaveBeenCalledWith({
      type: "contact.send",
      payload: { message: "Please call me", email: "visitor@example.com" },
      workspaceId: "ws_1",
      conversationId: "conv_1",
      idempotencyKey: "notify:req_1:contact_human",
    });
  });
});
