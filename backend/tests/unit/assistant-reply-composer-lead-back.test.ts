import { describe, expect, it, vi } from "vitest";

import { AssistantReplyComposer } from "../../src/modules/chat/services/assistantReplyComposer.js";
import type { ChatAnswerPresenter } from "../../src/modules/chat/services/chatAnswerPresenter.js";
import type { ChatAnswerSupport } from "../../src/modules/chat/services/chatAnswerSupport.js";
import type { ChatGateway } from "../../src/modules/chat/contracts/chatGateway.js";
import type { FallbackReplyComposer } from "../../src/modules/chat/services/fallbackReplyComposer.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";

const session = (overrides: Partial<PreparedSession> = {}): PreparedSession => ({
  agent: { id: "agent-1", workspaceId: "workspace-1", name: "Agent" },
  conversation: { id: "conversation-1", workspaceId: "workspace-1" },
  history: [],
  turnRoute: "direct",
  turnFraming: { intentTopic: "assistant identity", isIdentityQuestion: true },
  retrieval: { responseIdentity: null },
  ...overrides,
} as unknown as PreparedSession);

const composedPrompt = async (turnSession: PreparedSession): Promise<string> => {
  const answer = vi.fn(async () => "I'm the retreat assistant. Which dates would you like to come?");
  const composer = new AssistantReplyComposer(
    {
      buildAnswerInstructionBlock: () => "Help visitors book retreats.",
      buildContextBlock: () => "",
      pageContextCondition: () => null,
      buildChatWorkspaceContext: () => ({ workspaceId: "workspace-1" }),
      buildChatUsageContext: () => ({ surface: "assistant", operation: "direct" }),
    } as unknown as ChatAnswerSupport,
    { answer } as unknown as ChatGateway,
    { presentNonRetrievalAnswer: (text: string) => ({ answer: text }) } as unknown as ChatAnswerPresenter,
    {} as FallbackReplyComposer,
    { skillName: "assistant.direct", outcomeKind: "direct" },
  );
  await composer.composeAnswer(turnSession, "Are you a real person?", undefined, undefined);
  return (answer.mock.calls[0] as unknown as [{ prompt: string }])[0].prompt;
};

describe("AssistantReplyComposer lead-back to a parked routine (#1377)", () => {
  const pendingStep = {
    stepId: "ask_dates",
    instruction: "Ask for the arrival and departure dates.",
    missingSlotKeys: ["arrival", "departure"],
  };

  it("closes a direct reply to a digression with the parked step", async () => {
    const prompt = await composedPrompt(session({ routineYield: { routineId: "booking", pendingStep } }));

    expect(prompt).toContain(`- ${pendingStep.instruction}`);
  });

  it("says nothing of a routine on a turn no routine yielded", async () => {
    expect(await composedPrompt(session())).not.toContain(pendingStep.instruction);
  });
});
