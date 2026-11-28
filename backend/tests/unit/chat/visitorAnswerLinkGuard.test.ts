import { describe, expect, it, vi } from "vitest";

import { AssistantReplyComposer } from "../../../src/modules/chat/services/assistantReplyComposer.js";
import type { ChatAnswerPresenter } from "../../../src/modules/chat/services/chatAnswerPresenter.js";
import type { ChatAnswerSupport } from "../../../src/modules/chat/services/chatAnswerSupport.js";
import type { PreparedSession } from "../../../src/modules/chat/services/chatSessionPreparer.js";
import type { FallbackReplyComposer } from "../../../src/modules/chat/services/fallbackReplyComposer.js";
import { LinkGuardedChatGateway } from "../../../src/modules/chat/services/linkGuardedChatGateway.js";
import { BlankChatAnswerError } from "../../../src/modules/chat/services/chatAnswerErrors.js";
import type { ChatGateway, ChatGatewayInput } from "../../../src/modules/chat/contracts/chatGateway.js";
import { createDirectTurnSkill, DIRECT_REPLY_CONFIG } from "../../../src/modules/chat/services/directTurnSkill.js";
import { plannerReplySourceMetadata } from "../../../src/modules/chat/services/turnPlanQuickReply.js";
import type { TurnOutcome } from "../../../src/modules/chat/services/turnOutcome.js";

const GIVEN_INSTRUCTIONS = "Send visitors to https://school.example/enrol to enrol, or write to info@school.example.";

const session = {
  agent: { id: "agent-1", workspaceId: "workspace-1", name: "Agent" },
  conversation: { id: "conversation-1", workspaceId: "workspace-1" },
  userMessage: { id: "message-1", content: "How do I enrol?" },
  history: [],
  turnRoute: "direct",
  turnFraming: { intentTopic: "enrolment", isIdentityQuestion: false },
  retrieval: { responseIdentity: null },
} as unknown as PreparedSession;

const support = {
  buildAnswerInstructionBlock: () => GIVEN_INSTRUCTIONS,
  buildContextBlock: () => "",
  pageContextCondition: () => null,
  buildChatWorkspaceContext: () => ({ workspaceId: "workspace-1" }),
  buildChatUsageContext: () => ({ surface: "assistant", operation: "direct" }),
} as unknown as ChatAnswerSupport;

const presenter = { presentNonRetrievalAnswer: (text: string) => ({ answer: text }) } as unknown as ChatAnswerPresenter;

const fallback: FallbackReplyComposer = {
  async composeNoContext() {
    return { text: "See https://invented.example/help for more.", declineReason: "content_gap" };
  },
};

const composerFor = (
  outcomeKind: "direct" | "skill_result",
  chunks: string[],
  metrics = { incrementCounter: vi.fn() },
) => {
  const gateway: ChatGateway = {
    answer: async () => chunks.join(""),
    streamAnswer: async function* () {
      yield* chunks;
    },
  };
  return {
    metrics,
    composer: new AssistantReplyComposer(
      support,
      gateway,
      presenter,
      fallback,
      { skillName: `assistant.${outcomeKind}`, outcomeKind },
      metrics,
    ),
  };
};

const drain = async (stream: AsyncGenerator<string, { finalPresentation: { answer: string }; streamedAnswer: string }>) => {
  const chunks: string[] = [];
  let step = await stream.next();
  while (!step.done) {
    chunks.push(step.value);
    step = await stream.next();
  }
  return { chunks, result: step.value };
};

const INVENTED = "Enrol at [our site](https://invented.example/enrol) or https://invented.example/now, or at [the page](https://school.example/enrol).";
const GUARDED = "Enrol at our site or , or at [the page](https://school.example/enrol).";

describe("visitor answers that skip the retrieval composer keep to the addresses their model was sent", () => {
  it.each([
    ["a direct reply", "direct" as const, undefined],
    ["a reply written from a skill's result", "skill_result" as const, "Results: https://school.example/enrol"],
  ])("removes an invented address from %s", async (_name, kind, findings) => {
    const { composer, metrics } = composerFor(kind, [INVENTED]);

    const reply = await composer.composeAnswer(session, "How do I enrol?", undefined, undefined, findings);

    expect(reply.answer).toBe(GUARDED);
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      "chat_answer_links_unwrapped_total",
      expect.objectContaining({ labels: { reason: "not_given", stream: "false", path: kind } }),
    );
  });

  it.each([
    ["a direct reply", "direct" as const],
    ["a reply written from a skill's result", "skill_result" as const],
  ])("never streams an invented address in %s, and streams what the final reply holds", async (_name, kind) => {
    const pieces = Array.from(INVENTED.match(/.{1,5}/g) ?? []);
    const { composer, metrics } = composerFor(kind, pieces);

    const { chunks, result } = await drain(composer.streamAnswer(session, "How do I enrol?", undefined, undefined));

    expect(chunks.join("")).toBe(GUARDED);
    expect(chunks.join("")).not.toContain("invented.example");
    expect(result.finalPresentation.answer).toBe(GUARDED);
    expect(result.streamedAnswer).toBe(GUARDED);
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      "chat_answer_links_unwrapped_total",
      expect.objectContaining({ labels: { reason: "not_given", stream: "true", path: kind } }),
    );
  });

  it("keeps an address the reply prompt holds, in the whole reply and in the stream", async () => {
    const given = "Enrol at https://school.example/enrol or [write to us](mailto:info@school.example).";
    const { composer } = composerFor("direct", Array.from(given.match(/.{1,4}/g) ?? []));

    const whole = await composer.composeAnswer(session, "How do I enrol?", undefined, undefined);
    const streamed = await drain(composer.streamAnswer(session, "How do I enrol?", undefined, undefined));

    expect(whole.answer).toBe(given);
    expect(streamed.chunks.join("")).toBe(given);
  });

  it("guards the planner's quick reply as a direct reply", () => {
    const { composer, metrics } = composerFor("direct", []);

    const reply = composer.presentPlannedReply(session, "How do I enrol?", INVENTED);

    expect(reply.answer).toBe(GUARDED);
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      "chat_answer_links_unwrapped_total",
      expect.objectContaining({ labels: expect.objectContaining({ path: "direct" }) }),
    );
  });

  it("guards the decline composed for a blank reply", async () => {
    const { composer } = composerFor("direct", []);

    const reply = await composer.composeAnswer(session, "How do I enrol?", undefined, undefined);

    expect(reply.answer).toBe("See for more.");
  });
});

describe("the direct skill's quick reply", () => {
  it("keeps the planner's words to the addresses the direct reply prompt holds, rendered whole or committed", async () => {
    const { composer } = composerFor("direct", []);
    const skill = createDirectTurnSkill(composer, {});
    const outcome = {
      kind: "direct",
      skillName: DIRECT_REPLY_CONFIG.skillName,
      outcome: {
        status: "completed",
        answer: INVENTED,
        metadata: plannerReplySourceMetadata("acknowledgement", "planner"),
      },
    } as unknown as TurnOutcome;
    const context = { session, query: "How do I enrol?" };

    const rendered = await skill.renderer.render(outcome, context);
    const stream = skill.renderer.stream?.(outcome, context);
    const settled = await stream?.next();

    expect(rendered.answer).toBe(GUARDED);
    expect(settled?.done && settled.value.finalPresentation.answer).toBe(GUARDED);
  });
});

const gatewayWith = (completion: string, chunks: string[] = [completion]) => {
  const inputs: ChatGatewayInput[] = [];
  const inner: ChatGateway = {
    answer: async (input) => {
      inputs.push(input);
      return completion;
    },
    streamAnswer: async function* (input) {
      inputs.push(input);
      yield* chunks;
    },
  };
  return { inputs, inner };
};

const input = (overrides: Partial<ChatGatewayInput> = {}): ChatGatewayInput => ({
  query: "How do I enrol?",
  history: [],
  prompt: "assistant: Enrolment is at https://school.example/enrol.\nuser: How do I enrol?",
  systemPrompt: "Write the next step's reply.",
  usageContext: { surface: "assistant", operation: "routine_turn" } as ChatGatewayInput["usageContext"],
  ...overrides,
});

describe("LinkGuardedChatGateway", () => {
  it("guards a completion the call says the visitor reads as written, against what the call sent", async () => {
    const { inner } = gatewayWith("Enrol at [the page](https://school.example/enrol) or https://invented.example/now.");
    const metrics = { incrementCounter: vi.fn() };
    const gateway = new LinkGuardedChatGateway(inner, "routine", metrics);

    const text = await gateway.answer(input({ writesVisitorText: true }));

    expect(text).toBe("Enrol at [the page](https://school.example/enrol) or .");
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      "chat_answer_links_unwrapped_total",
      expect.objectContaining({ labels: { reason: "not_given", stream: "false", path: "routine" } }),
    );
  });

  it("guards a streamed completion without releasing any of an invented address", async () => {
    const reply = "Enrol at [the page](https://invented.example/enrol) or https://invented.example/now, thanks.";
    const { inner } = gatewayWith(reply, Array.from(reply.match(/.{1,3}/g) ?? []));
    const gateway = new LinkGuardedChatGateway(inner, "routine");

    const released: string[] = [];
    for await (const delta of gateway.streamAnswer(input({ writesVisitorText: true }))) {
      released.push(delta);
    }

    expect(released.join("")).toBe("Enrol at the page or , thanks.");
    expect(released.join("")).not.toContain("invented");
  });

  it("passes a completion nothing marked as visitor text through byte for byte", async () => {
    const json = "{\"next\":\"[x](https://invented.example)\\nhttps://invented.example\"}";
    const { inner } = gatewayWith(json);
    const gateway = new LinkGuardedChatGateway(inner, "routine");

    expect(await gateway.answer(input())).toBe(json);
    const streamed: string[] = [];
    for await (const delta of gateway.streamAnswer(input())) {
      streamed.push(delta);
    }
    expect(streamed.join("")).toBe(json);
  });

  it("fails a completion that was only an invented address as blank, so the caller retries it", async () => {
    const { inner } = gatewayWith("https://invented.example/now");
    const gateway = new LinkGuardedChatGateway(inner, "routine");

    await expect(gateway.answer(input({ writesVisitorText: true }))).rejects.toBeInstanceOf(BlankChatAnswerError);
  });
});
