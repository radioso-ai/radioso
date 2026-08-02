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
  it("fills a directive-bound handler's declared input and parks missing required input without dispatch", async () => {
    const appointment = recordingSkillHandler();
    const gateway: ConversationModelGateway = {
      complete: vi.fn(async ({ systemPrompt, messages }) => {
        if (systemPrompt?.includes("Extract only the declared JSON fields")) {
          return { text: messages.at(-1)?.content.includes("Friday") ? JSON.stringify({ date: "2026-08-07" }) : "{}" };
        }
        return { text: "Please provide a date." };
      }),
    };
    const kit = createConversationKit({
      modelGateway: gateway,
      directives: [{
        name: "appointment",
        condition: { kind: "always" },
        action: "Book the appointment.",
        binding: { kind: "skill", skillName: "book" },
      }],
      skills: [{ name: "book", inputSchema: { fields: [
        { name: "date", type: "date", required: true },
        { name: "style", type: "string", required: false, permittedValues: ["Short", "Long"] },
      ] } }],
      localSkills: new Map([["book", appointment.handler]]),
    });

    await kit.runTurn({ sessionId: "s_filled", message: "Book it for Friday" });
    expect(appointment.calls[0]?.input).toEqual({ date: "2026-08-07" });
    expect(appointment.calls[0]?.input).not.toHaveProperty("style");

    const parked = await kit.runTurn({ sessionId: "s_parked", message: "Book it" });
    expect(appointment.calls).toHaveLength(1);
    expect(parked.awaitingSkillInput).toEqual([{ skillName: "book", fields: [{ name: "date", type: "date", reason: "absent" }] }]);
    expect(parked.response.answer).toBe("Please provide a date.");

    await kit.runTurn({ sessionId: "s_parked", message: "Friday works." });
    expect(appointment.calls).toHaveLength(2);
    expect(appointment.calls[1]?.input).toEqual({ date: "2026-08-07" });
  });

  it("uses valid host-selected input without extraction and preserves no-fields input", async () => {
    const model = echoGateway();
    const hostSelected = recordingSkillHandler();
    const legacy = recordingSkillHandler();
    const selector = {
      select: vi.fn(async ({ skills }: { skills: SkillDefinition[] }) => ({
        selected: skills.map((skill) => skill.name === "host_selected"
          ? { skillName: skill.name, input: { date: "2026-08-07" } }
          : { skillName: skill.name, input: { untouched: true } }),
      })),
    };
    const kit = createConversationKit({
      modelGateway: model,
      skills: [
        { name: "host_selected", inputSchema: { fields: [{ name: "date", type: "date", required: true }] } },
        { name: "legacy" },
      ],
      selector,
      composer: { compose: vi.fn(async () => ({ answer: "done" })) },
      localSkills: new Map([
        ["host_selected", hostSelected.handler],
        ["legacy", legacy.handler],
      ]),
    });

    await kit.runTurn({ sessionId: "s_host", message: "ignored" });

    expect(model.complete).not.toHaveBeenCalled();
    expect(hostSelected.calls[0]?.input).toEqual({ date: "2026-08-07" });
    expect(legacy.calls[0]?.input).toEqual({ untouched: true });
  });

  it("fills a selected skill from bounded earlier conversation history", async () => {
    const appointment = recordingSkillHandler();
    const gateway: ConversationModelGateway = {
      complete: vi.fn(async () => ({ text: JSON.stringify({ date: "2026-08-07" }) })),
    };
    const kit = createConversationKit({
      modelGateway: gateway,
      skills: [{ name: "book", inputSchema: { fields: [{ name: "date", type: "date", required: true }] } }],
      selector: {
        select: vi.fn(async ({ turn }) => ({
          selected: turn.history.some((message) => message.content.includes("August 7"))
            ? [{ skillName: "book" }]
            : [],
        })),
      },
      composer: { compose: vi.fn(async () => ({ answer: "done" })) },
      localSkills: new Map([["book", appointment.handler]]),
    });

    await kit.runTurn({ sessionId: "s_history", message: "The appointment date is August 7." });
    await kit.runTurn({ sessionId: "s_history", message: "Please book it." });

    expect(appointment.calls[0]?.input).toEqual({ date: "2026-08-07" });
  });

  it("parks an invalid extracted value instead of passing it to a directive-bound handler", async () => {
    const appointment = recordingSkillHandler();
    const gateway: ConversationModelGateway = {
      complete: vi.fn(async ({ systemPrompt }) => systemPrompt?.includes("Extract only the declared JSON fields")
        ? { text: JSON.stringify({ date: "Friday", ignored: "secret" }) }
        : { text: "Please provide a calendar date." }),
    };
    const kit = createConversationKit({
      modelGateway: gateway,
      directives: [{
        name: "appointment",
        condition: { kind: "always" },
        action: "Book the appointment.",
        binding: { kind: "skill", skillName: "book" },
      }],
      skills: [{ name: "book", inputSchema: { fields: [{ name: "date", type: "date", required: true }] } }],
      localSkills: new Map([["book", appointment.handler]]),
    });

    const result = await kit.runTurn({ sessionId: "s_invalid", message: "Book for Friday" });

    expect(appointment.calls).toHaveLength(0);
    expect(result.awaitingSkillInput).toEqual([{
      skillName: "book",
      fields: [{ name: "date", type: "date", reason: "rejected" }],
    }]);
    expect(JSON.stringify(result.trace)).not.toContain("Friday");
    expect(JSON.stringify(result.trace)).not.toContain("secret");
  });

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
