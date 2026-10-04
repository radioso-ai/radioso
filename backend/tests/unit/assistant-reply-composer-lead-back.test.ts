import { describe, expect, it, vi } from "vitest";

import { AssistantReplyComposer } from "../../src/modules/chat/services/assistantReplyComposer.js";
import type { ChatAnswerPresenter } from "../../src/modules/chat/services/chatAnswerPresenter.js";
import type { ChatAnswerSupport } from "../../src/modules/chat/services/chatAnswerSupport.js";
import type { FallbackReplyComposer, FallbackReplyInput } from "../../src/modules/chat/services/fallbackReplyComposer.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";

const pendingStep = {
  stepId: "ask_dates",
  instruction: "Ask for the arrival and departure dates.",
  missingSlotKeys: ["arrival", "departure"],
};

const session = (overrides: Partial<PreparedSession> = {}): PreparedSession => ({
  agent: { id: "agent-1", workspaceId: "workspace-1", name: "Agent" },
  conversation: { id: "conversation-1", workspaceId: "workspace-1" },
  history: [],
  turnRoute: "direct",
  turnFraming: { intentTopic: "assistant identity", isIdentityQuestion: true },
  retrieval: { responseIdentity: null },
  ...overrides,
} as unknown as PreparedSession);

const parked = (): PreparedSession => session({
  routineYield: { sessionId: "conversation-1", inputEventId: "message-1", routineId: "booking", pendingStep },
});

const composer = (reply: string) => {
  const answer = vi.fn(async () => reply);
  async function* streamAnswer() {
    if (reply) {
      yield reply;
    }
  }
  const declines: FallbackReplyInput[] = [];
  const fallback: FallbackReplyComposer = {
    async composeNoContext(input) {
      declines.push(input);
      return { text: "I can't help with that one here.", declineReason: "content_gap" };
    },
  };
  return {
    answer,
    declines,
    composer: new AssistantReplyComposer(
      {
        buildAnswerInstructionBlock: () => "Help visitors book retreats.",
        buildContextBlock: () => "",
        pageContextCondition: () => null,
        buildChatWorkspaceContext: () => ({ workspaceId: "workspace-1" }),
        buildChatUsageContext: () => ({ surface: "assistant", operation: "direct" }),
      } as unknown as ChatAnswerSupport,
      { answer, streamAnswer },
      { presentNonRetrievalAnswer: (text: string) => ({ answer: text }) } as unknown as ChatAnswerPresenter,
      fallback,
      { skillName: "assistant.direct", outcomeKind: "direct" },
    ),
  };
};

const drain = async (stream: AsyncGenerator<string, unknown>): Promise<void> => {
  let step = await stream.next();
  while (!step.done) {
    step = await stream.next();
  }
};

describe("AssistantReplyComposer lead-back to a parked routine (#1377)", () => {
  it("closes a direct reply to a digression with the parked step", async () => {
    const { composer: direct, answer } = composer("I'm the retreat assistant. Which dates would you like to come?");

    await direct.composeAnswer(parked(), "Are you a real person?", undefined, undefined);

    expect((answer.mock.calls[0] as unknown as [{ prompt: string }])[0].prompt).toContain(`- ${pendingStep.instruction}`);
  });

  it("says nothing of a routine on a turn no routine yielded", async () => {
    const { composer: direct, answer, declines } = composer("");

    await direct.composeAnswer(session(), "Are you a real person?", undefined, undefined);

    expect((answer.mock.calls[0] as unknown as [{ prompt: string }])[0].prompt).not.toContain(pendingStep.instruction);
    expect(declines[0]?.pendingRoutineStep).toBeUndefined();
  });

  it("carries the parked step into the decline composed for a blank direct reply", async () => {
    const { composer: direct, declines } = composer("");

    await direct.composeAnswer(parked(), "Are you a real person?", undefined, undefined);

    expect(declines).toHaveLength(1);
    expect(declines[0]?.pendingRoutineStep).toEqual(pendingStep);
  });

  it("carries the parked step into the decline composed for a blank streamed direct reply", async () => {
    const { composer: direct, declines } = composer("");

    await drain(direct.streamAnswer(parked(), "Are you a real person?", undefined, undefined));

    expect(declines).toHaveLength(1);
    expect(declines[0]?.pendingRoutineStep).toEqual(pendingStep);
  });
});
