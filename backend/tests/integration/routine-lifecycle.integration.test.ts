import request from "supertest";
import { describe, expect, it } from "vitest";

import type { ChatGateway } from "../../src/modules/chat/services/chatService.js";
import type { RoutineDefinitionDraftInput } from "../../src/modules/routines/public.js";
import { createTestApp, issueTestToken } from "../support/testApp.js";

const lifecycleRoutineDraft = (label: string): RoutineDefinitionDraftInput => ({
  name: "lifecycle-intake",
  activation: {
    triggerDescription: "When the user asks to start lifecycle intake.",
    gateRef: null,
    priority: 10,
  },
  slots: [{
    stableSlotId: "slot_topic",
    key: "topic",
    type: "text",
    required: true,
    description: "The lifecycle topic",
    ordinal: 0,
  }],
  steps: [{
    stableStepId: "step_collect_topic",
    kind: "chat",
    instruction: `${label}: ask for {{slot.topic}}.`,
    toolRef: null,
    ordinal: 0,
    metadata: {},
  }],
  transitions: [{
    fromStep: "step_collect_topic",
    toRef: "terminal_complete",
    guardKind: "llm",
    guardText: "The user provided {{slot.topic}}.",
    outcomeStatus: null,
    counterLimit: null,
    ordinal: 0,
  }],
  terminals: [{
    stableStepId: "terminal_complete",
    kind: "complete",
    instruction: `${label}: complete intake for {{slot.topic}}.`,
    ordinal: 1,
  }],
});

const routineVersionFromPrompt = (systemPrompt: string | undefined): string => {
  if (systemPrompt?.includes("v2:")) {
    return "v2";
  }
  if (systemPrompt?.includes("v1:")) {
    return "v1";
  }
  return "unknown";
};

describe("routine lifecycle integration", () => {
  it("resumes pinned superseded and archived versions while new sessions activate only published versions", async () => {
    const activationPrompts: string[] = [];
    const routineGateway: ChatGateway = {
      async answer(input) {
        if (input.systemPrompt?.includes("wants to start any registered routine")) {
          activationPrompts.push(input.systemPrompt);
          const routineId = input.systemPrompt.match(/id: (\S+)/)?.[1];
          return JSON.stringify({
            matches: routineId ? [{ routineId, confidence: 0.95, variables: {} }] : [],
          });
        }
        if (input.systemPrompt?.includes("conditions")) {
          return JSON.stringify({ condition: 1, variables: { topic: "billing" } });
        }
        if (input.systemPrompt?.includes("v1:")) {
          return `reply:${routineVersionFromPrompt(input.systemPrompt)}`;
        }
        if (input.systemPrompt?.includes("v2:")) {
          return `reply:${routineVersionFromPrompt(input.systemPrompt)}`;
        }
        return "normal answer";
      },
      async *streamAnswer() {
        yield "normal answer";
      },
    };
    const { app, dependencies } = createTestApp({ chatGateway: routineGateway });
    const { token, workspaceId } = await issueTestToken(app, "routine-lifecycle@example.com");
    const authorization = `Bearer ${token}`;
    const agent = await dependencies.agentService.resolve(workspaceId);

    const draftV1 = await dependencies.routineDefinitionService.createDraft(workspaceId, agent.id, lifecycleRoutineDraft("v1"));
    const publishV1 = await dependencies.routineDefinitionService.publish(workspaceId, agent.id, draftV1.routine.id);
    if ("rejected" in publishV1) {
      throw new Error("expected v1 publish success");
    }

    const firstV1 = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ message: "start lifecycle intake", stream: false })
      .expect(200);
    expect(firstV1.body.answer).toBe("reply:v1");

    const revision = await dependencies.routineDefinitionService.revise(workspaceId, agent.id, publishV1.routine.id);
    await dependencies.routineDefinitionService.updateDraft(workspaceId, agent.id, revision.id, lifecycleRoutineDraft("v2"));
    const publishV2 = await dependencies.routineDefinitionService.publish(workspaceId, agent.id, revision.id);
    if ("rejected" in publishV2) {
      throw new Error("expected v2 publish success");
    }

    const secondV1 = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ conversationId: firstV1.body.conversationId, message: "billing", stream: false })
      .expect(200);
    expect(secondV1.body.answer).toBe("reply:v1");

    const firstV2 = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ message: "start lifecycle intake", stream: false })
      .expect(200);
    expect(firstV2.body.answer).toBe("reply:v2");
    expect(activationPrompts.at(-1)).toContain(`:v${publishV2.routine.version}`);
    expect(activationPrompts.at(-1)).not.toContain(`:v${publishV1.routine.version}`);

    await dependencies.routineDefinitionService.archive(workspaceId, agent.id, publishV2.routine.id);
    const activationPromptCountAfterArchive = activationPrompts.length;

    const archivedPinned = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ conversationId: firstV2.body.conversationId, message: "billing", stream: false })
      .expect(200);
    expect(archivedPinned.body.answer).toBe("reply:v2");

    const afterArchive = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ message: "start lifecycle intake", stream: false })
      .expect(200);
    expect(afterArchive.body.answer).not.toBe("reply:v2");
    expect(afterArchive.body.answer).not.toBe("reply:v1");
    expect(activationPrompts).toHaveLength(activationPromptCountAfterArchive);
  });
});
