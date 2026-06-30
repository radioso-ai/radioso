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
      },
      emit: noopSkillEmitPort,
    });

    expect(result).toMatchObject({ disposition: "settled", outcome: { status: "enqueued" } });
    expect(outbox.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      type: "slack.post",
      accountId: "account-1",
      idempotencyKey: "slack:routine_post:session-1:routine-1:step-1:post_to_support",
      payload: expect.objectContaining({
        kind: "routine_post",
        channelId: "CSUPPORT",
        text: "Qualified lead",
      }),
    }));
  });
});
