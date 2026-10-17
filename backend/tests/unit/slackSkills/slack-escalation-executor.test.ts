import { describe, expect, it, vi } from "vitest";

import { SlackEscalationExecutor, slackRoutineSkillDefinition } from "../../../src/modules/slackSkills/public.js";
import { noopSkillEmitPort } from "../../../src/modules/skills/public.js";

describe("SlackEscalationExecutor", () => {
  it("enqueues the shared slack.post action for routine-authored posts", async () => {
    const outbox = { enqueue: vi.fn(async () => ({ id: "action-1", duplicate: false })) };
    const executor = new SlackEscalationExecutor({
      outbox,
      skills: {
        findEnabledByName: vi.fn(async () => ({
          id: "skill-1",
          workspaceId: "workspace-1",
          agentId: "agent-1",
          installationId: "11111111-1111-1111-1111-111111111111",
          skillName: "post_to_support",
          boundInputs: { channelId: "CSUPPORT" },
          exposedInputs: { text: { slotBinding: "handoffText" } },
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      },
    });

    const result = await executor.dispatch({
      skill: slackRoutineSkillDefinition("post_to_support"),
      collected: { handoffText: "Qualified lead" },
      context: {
        workspaceId: "workspace-1",
        accountId: "account-1",
        agentId: "agent-1",
        conversationId: "conversation-1",
        sessionId: "session-1",
        routineId: "routine-1",
        stepId: "step-1",
        idempotencyKey: "approval-decision:decision-1:step:step-1",
      },
      emit: noopSkillEmitPort,
    });

    expect(result).toMatchObject({ disposition: "settled", outcome: { status: "enqueued" } });
    expect(outbox.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      type: "slack.post",
      accountId: "account-1",
      idempotencyKey: "slack:routine_post:approval-decision:decision-1:step:step-1",
      payload: expect.objectContaining({
        kind: "routine_post",
        channelId: "CSUPPORT",
        text: "Qualified lead",
      }),
    }));
  });

  it("enqueues a private test's post with no conversation link, keeping the turn's id as the payload's reference", async () => {
    const outbox = { enqueue: vi.fn(async () => ({ id: "action-1", duplicate: false })) };
    const executor = new SlackEscalationExecutor({
      outbox,
      skills: {
        findEnabledByName: vi.fn(async () => ({
          id: "skill-1",
          workspaceId: "workspace-1",
          agentId: "agent-1",
          installationId: "11111111-1111-1111-1111-111111111111",
          skillName: "post_to_support",
          boundInputs: { channelId: "CSUPPORT", text: "Qualified lead" },
          exposedInputs: {},
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      },
    });
    const dispatch = (conversationDurability: "durable" | "ephemeral") => executor.dispatch({
      skill: slackRoutineSkillDefinition("post_to_support"),
      collected: {},
      context: {
        workspaceId: "workspace-1",
        accountId: "account-1",
        agentId: "agent-1",
        conversationId: "minted-test-conversation",
        sessionId: "minted-test-conversation",
        conversationDurability,
        routineId: "routine-1",
        stepId: "step-1",
      },
      emit: noopSkillEmitPort,
    });

    await dispatch("ephemeral");
    await dispatch("durable");

    expect(outbox.enqueue).toHaveBeenNthCalledWith(1, expect.objectContaining({
      conversationId: null,
      payload: expect.objectContaining({ conversationRef: "minted-test-conversation" }),
    }));
    expect(outbox.enqueue).toHaveBeenNthCalledWith(2, expect.objectContaining({ conversationId: "minted-test-conversation" }));
  });
});
