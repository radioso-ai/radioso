import { describe, expect, it, vi } from "vitest";

import type { ConversationModelGateway, SkillDefinition } from "@radioso/conversation-contract";

import {
  createConversationKit,
  type LocalSkillHandler,
  type LocalSkillHandlerInput,
} from "../src/index.js";

const echoGateway = (): ConversationModelGateway => ({
  complete: vi.fn(async ({ messages }) => ({ text: `reply:${messages.at(-1)?.content ?? ""}` })),
});

const recordingSkillHandler = (outputs: Record<string, unknown> = {}): {
  handler: LocalSkillHandler;
  calls: LocalSkillHandlerInput[];
} => {
  const calls: LocalSkillHandlerInput[] = [];
  const handler: LocalSkillHandler = async (input) => {
    calls.push(input);
    return { disposition: "settled", outcome: { status: "completed", outputs } };
  };
  return { handler, calls };
};

const orderLookupSkill: SkillDefinition = { name: "order_lookup" };
const refundSkill: SkillDefinition = { name: "refund" };

describe("createConversationKit", () => {
  it("runs a full turn through defaults, engine, and a mock model gateway", async () => {
    const gateway: ConversationModelGateway = {
      complete: vi.fn(async ({ systemPrompt, messages }) => ({
        text: `reply:${messages.at(-1)?.content ?? ""}`,
        metadata: {
          sawDirective: systemPrompt?.includes("Answer in one sentence.") ?? false,
        },
      })),
    };
    const kit = createConversationKit({
      modelGateway: gateway,
      agent: {
        id: "agent_hello",
        name: "Hello Agent",
        instructions: ["Be useful."],
      },
      directives: [
        {
          name: "brief",
          condition: { kind: "always" },
          action: "Answer in one sentence.",
        },
      ],
    });

    const result = await kit.runTurn({
      sessionId: "session_hello",
      message: "Hello kit",
    });

    expect(result.response.answer).toBe("reply:Hello kit");
    expect(result.response.metadata).toMatchObject({ sawDirective: true });
    expect(result.trace.stages.map((stage) => stage.kind)).toEqual([
      "message",
      "gather",
      "directive_match",
      "skill_selection",
      "compose",
    ]);
    expect(gateway.complete).toHaveBeenCalledWith(expect.objectContaining({
      messages: [{ role: "user", content: "Hello kit" }],
      systemPrompt: expect.stringContaining("Answer in one sentence."),
    }));
    expect(kit.listEvents("session_hello").map((event) => event.role)).toEqual(["user", "assistant"]);
  });
});

describe("default skill selection", () => {
  it("dispatches the skill an authored directive binds, with no metadata on the turn", async () => {
    const lookup = recordingSkillHandler({ eta: "tomorrow" });
    const kit = createConversationKit({
      modelGateway: echoGateway(),
      directives: [
        {
          name: "order_status",
          condition: { kind: "always" },
          action: "Look up the order.",
          binding: { kind: "skill", skillName: "order_lookup" },
        },
      ],
      skills: [orderLookupSkill],
      localSkills: new Map([["order_lookup", lookup.handler]]),
    });

    const result = await kit.runTurn({ sessionId: "s_bound", message: "where is my order" });

    expect(result.decision.selected.map((selected) => selected.skillName)).toEqual(["order_lookup"]);
    expect(result.decision.reason).toBe("directive:order_status");
    expect(lookup.calls).toHaveLength(1);
    expect(result.outcomes.map((outcome) => outcome.skillName)).toEqual(["order_lookup"]);
  });

  it("lets explicit input metadata override an opposing directive binding", async () => {
    const lookup = recordingSkillHandler({ eta: "tomorrow" });
    const refund = recordingSkillHandler({ refundId: "r_1" });
    const kit = createConversationKit({
      modelGateway: echoGateway(),
      directives: [
        {
          name: "order_status",
          condition: { kind: "always" },
          action: "Look up the order.",
          binding: { kind: "skill", skillName: "order_lookup" },
        },
      ],
      skills: [orderLookupSkill, refundSkill],
      localSkills: new Map([
        ["order_lookup", lookup.handler],
        ["refund", refund.handler],
      ]),
    });

    const result = await kit.runTurn({
      sessionId: "s_override",
      message: "refund it",
      metadata: { skillName: "refund" },
    });

    expect(result.decision.selected.map((selected) => selected.skillName)).toEqual(["refund"]);
    expect(result.decision.reason).toBe("selected_requested_skills");
    expect(refund.calls).toHaveLength(1);
    expect(lookup.calls).toHaveLength(0);
  });

  it("selects nothing and does not throw when a directive binds an unregistered skill", async () => {
    const lookup = recordingSkillHandler();
    const kit = createConversationKit({
      modelGateway: echoGateway(),
      directives: [
        {
          name: "escalate",
          condition: { kind: "always" },
          action: "Escalate the request.",
          binding: { kind: "skill", skillName: "not_registered" },
        },
      ],
      skills: [orderLookupSkill],
      localSkills: new Map([["order_lookup", lookup.handler]]),
    });

    const result = await kit.runTurn({ sessionId: "s_unregistered", message: "help me" });

    expect(result.decision.selected).toEqual([]);
    expect(result.decision.reason).toBe("directive_bindings_skipped");
    expect(lookup.calls).toHaveLength(0);
    expect(result.response.answer).toBe("reply:help me");
  });

  it("selects no skill when nothing is bound and no metadata is supplied", async () => {
    const lookup = recordingSkillHandler();
    const kit = createConversationKit({
      modelGateway: echoGateway(),
      directives: [{ name: "brief", condition: { kind: "always" }, action: "Be brief." }],
      skills: [orderLookupSkill],
      localSkills: new Map([["order_lookup", lookup.handler]]),
    });

    const result = await kit.runTurn({ sessionId: "s_none", message: "hello" });

    expect(result.decision.selected).toEqual([]);
    expect(lookup.calls).toHaveLength(0);
    expect(result.response.answer).toBe("reply:hello");
  });
});
