import { describe, expect, it, vi } from "vitest";

import type {
  ConversationModelGateway,
  ConversationModelRequest,
  RoutineEndingRun,
  RoutineStep,
  RoutineStepReplyInput,
  RoutineStepSkillResult,
  SteeringRule,
  TurnContext,
} from "@radioso/conversation-contract";
import { RoutineStepRenderer } from "../src/index.js";

/**
 * A step rendered after a tool step on the same turn reads what the tool returned (#1883). A
 * customer lookup completed and assigned the customer's name, and the ending that was to tell the
 * visitor the name said nothing was found: its reply heard only `lookup_customer → completed`,
 * and was told it had no source to take the name from.
 */

const ENDING_TEXT = "Tell the visitor the customer's first name and city that the lookup returned.";
const finishEnding: RoutineStep = { id: "done", kind: "terminal", action: ENDING_TEXT, metadata: { terminalKind: "complete" } };
const handoffEnding: RoutineStep = { id: "agent", kind: "terminal", action: ENDING_TEXT, metadata: { terminalKind: "handoff" } };
const confirmStep: RoutineStep = { id: "confirm", kind: "chat", action: "Ask whether this is the right customer." };

const routineRule = (action: string): SteeringRule => ({ action, source: "routine", lifespan: "response" });

const turn: TurnContext = {
  agent: { id: "a", name: "Shop Desk" },
  sessionId: "s1",
  inputEvent: { id: "i1", kind: "message", content: "Customer 5, please." },
  history: [],
  stagedContext: [],
  steering: [],
};

const foundCustomer: RoutineStepSkillResult = {
  skillName: "lookup_customer",
  status: "completed",
  outputs: { first_name: "Emily", city: "Phoenix" },
  outputContract: {
    first_name: { type: "text", description: "First name" },
    city: { type: "text", description: "City" },
  },
};

const noProducts: RoutineStepSkillResult = {
  skillName: "search_products",
  status: "completed",
  outputs: { products: [] },
  outputContract: { products: { type: "list", fields: { title: { type: "text", role: "title" } } } },
};

const lookupCompleted: RoutineEndingRun = {
  requestPassedOn: false,
  skillOutcomes: [{ skillName: "lookup_customer", status: "completed" }],
};

// What the reply is told, read off templates that print only that.
const TOOLS_TEMPLATE = "TOOLS[{{tool_results}}]";
const ENDING_TEMPLATE = "ENDING[{{skill_outcomes}}]";

const requestFor = async (
  input: Partial<RoutineStepReplyInput>,
  options: ConstructorParameters<typeof RoutineStepRenderer>[1] = {},
): Promise<ConversationModelRequest> => {
  const gateway: ConversationModelGateway = { complete: vi.fn(async () => ({ text: "ok" })) };
  await new RoutineStepRenderer(gateway, {
    stepToolResultsPromptTemplate: TOOLS_TEMPLATE,
    stepEndingPromptTemplate: ENDING_TEMPLATE,
    ...options,
  }).render({ step: finishEnding, steering: [routineRule(ENDING_TEXT)], turn, ...input });
  expect(gateway.complete).toHaveBeenCalledTimes(1);
  return vi.mocked(gateway.complete).mock.calls[0][0];
};

const toolResultsOf = async (input: Partial<RoutineStepReplyInput>): Promise<string> =>
  (await requestFor(input, { promptTemplate: "{{tool_results}}" })).systemPrompt ?? "";

describe("RoutineStepRenderer gives a step reply what this turn's tool steps returned (#1883)", () => {
  it("renders a result as typed, described lines under its tool and outcome", async () => {
    expect(await toolResultsOf({ skillResults: [foundCustomer] })).toBe(
      [
        "TOOLS[`lookup_customer` → `completed`:",
        "first_name — First name (text): \"Emily\"",
        "city — City (text): \"Phoenix\"]",
        "",
        "",
      ].join("\n"),
    );
  });

  it("says a result returned no values when no declared output came back, an empty list included", async () => {
    expect(await toolResultsOf({ skillResults: [noProducts] })).toBe("TOOLS[`search_products` → `completed`: returned no values]\n\n");
    expect(await toolResultsOf({ skillResults: [{ ...foundCustomer, outputs: {} }] })).toBe(
      "TOOLS[`lookup_customer` → `completed`: returned no values]\n\n",
    );
  });

  it("renders only the outputs the contract declares", async () => {
    const extra = { ...foundCustomer, outputs: { ...foundCustomer.outputs, internal: "row-17" } };

    expect(await toolResultsOf({ skillResults: [extra] })).not.toContain("row-17");
  });

  it("leaves out a result whose tool name or status does not read as an identifier", async () => {
    expect(await toolResultsOf({ skillResults: [{ ...foundCustomer, skillName: "lookup customer" }, noProducts] })).toBe(
      "TOOLS[`search_products` → `completed`: returned no values]\n\n",
    );
  });

  it("adds nothing to a reply whose turn ran no tool step with a contract", async () => {
    expect(await toolResultsOf({})).toBe("");
    expect(await toolResultsOf({ skillResults: [] })).toBe("");
  });

  it("gives a chat step the results as well as an ending", async () => {
    expect(await toolResultsOf({ step: confirmStep, steering: [routineRule(confirmStep.action ?? "")], skillResults: [foundCustomer] }))
      .toContain("first_name — First name (text): \"Emily\"");
  });

  it("counts the results as a source of the reply, and names them only when there are some", async () => {
    const sourcesOf = async (input: Partial<RoutineStepReplyInput>) =>
      (await requestFor(input, {
        promptTemplate: "{{step_sources}}",
        stepSourcesPromptTemplate: "SOURCES[retrieved={{retrieved_excerpts}},evidence={{context_evidence}}]",
        stepSourcesToolResultsPromptTemplate: "SOURCES[retrieved={{retrieved_excerpts}},evidence={{context_evidence}},tools]",
        stepSourcesNonePromptTemplate: "SOURCES[none]",
      })).systemPrompt;

    expect(await sourcesOf({ skillResults: [foundCustomer] })).toBe("SOURCES[retrieved=none,evidence=none,tools]");
    expect(await sourcesOf({ contextEvidence: ["<page_excerpt>Rooms</page_excerpt>"] })).toBe("SOURCES[retrieved=none,evidence=provided]");
    expect(await sourcesOf({})).toBe("SOURCES[none]");
  });

  it("says nothing about tool results in the shipped prompts of a turn that has none", async () => {
    const shipped = { stepToolResultsPromptTemplate: undefined, stepEndingPromptTemplate: undefined };
    const mcpEnding: RoutineEndingRun = { requestPassedOn: false, skillOutcomes: [{ skillName: "search_listings", status: "empty" }] };
    const prompts = [
      (await requestFor({ step: confirmStep, steering: [routineRule(confirmStep.action ?? "")], contextEvidence: ["<page_excerpt>Rooms</page_excerpt>"] }, shipped)).systemPrompt,
      (await requestFor({ ending: mcpEnding }, shipped)).systemPrompt,
      (await requestFor({ step: handoffEnding, ending: mcpEnding }, shipped)).systemPrompt,
    ];

    for (const prompt of prompts) {
      expect(prompt).not.toContain("returned on this turn");
      expect(prompt).not.toContain("values tool steps returned");
      expect(prompt).not.toContain("returned no values");
    }
  });

  it("reads a completed write that returned no values as one that went through, with nothing to quote", async () => {
    const booked: RoutineStepSkillResult = { skillName: "book_viewing", status: "completed", outputs: {}, outputContract: { reference: { type: "text" } } };
    const ending: RoutineEndingRun = { requestPassedOn: true, skillOutcomes: [{ skillName: "book_viewing", status: "completed" }] };
    const shipped = { stepToolResultsPromptTemplate: undefined, stepEndingPromptTemplate: undefined };

    for (const step of [finishEnding, handoffEnding]) {
      const systemPrompt = (await requestFor({ step, ending, skillResults: [booked] }, shipped)).systemPrompt ?? "";
      const notThroughRules = systemPrompt.split("\n").filter((line) => line.includes("did not go through"));

      expect(systemPrompt).toContain("`book_viewing` → `completed`: returned no values");
      expect(notThroughRules).not.toEqual([]);
      // Whether a tool found nothing or did not go through is its outcome's to say, never its values'.
      expect(notThroughRules.filter((line) => line.includes("no values"))).toEqual([]);
      expect(systemPrompt).toContain("does not mean the tool found nothing or failed");
    }
  });

  it("puts the results once in the shipped step reply, before its sources line and the ending's facts", async () => {
    const systemPrompt = (await requestFor({ skillResults: [foundCustomer], ending: lookupCompleted }, {
      stepToolResultsPromptTemplate: undefined,
      stepEndingPromptTemplate: undefined,
    })).systemPrompt ?? "";

    const resultsAt = systemPrompt.indexOf("first_name — First name (text): \"Emily\"");
    expect(resultsAt).toBeGreaterThan(systemPrompt.indexOf(ENDING_TEXT));
    expect(systemPrompt.split("\"Emily\"")).toHaveLength(2);
    expect(resultsAt).toBeLessThan(systemPrompt.indexOf("Sources for this message"));
    expect(resultsAt).toBeLessThan(systemPrompt.indexOf("`lookup_customer` → `completed`", resultsAt + 1));
  });

  it("keeps the shipped step reply the same for an empty result list as for none", async () => {
    const shipped = { stepToolResultsPromptTemplate: undefined, stepEndingPromptTemplate: undefined };
    const without = (await requestFor({ ending: lookupCompleted }, shipped)).systemPrompt;

    expect((await requestFor({ ending: lookupCompleted, skillResults: [] }, shipped)).systemPrompt).toBe(without);
  });

  it("tells a hand-off ending with a message what the tools returned, before the run's facts", async () => {
    const request = await requestFor(
      { step: handoffEnding, ending: lookupCompleted, skillResults: [noProducts] },
      { terminalHandoffWithMessagePromptTemplate: "MEANING[{{message}}]{{ending_run}}" },
    );

    expect(request.systemPrompt).toBe(
      `MEANING[${ENDING_TEXT}]\nTOOLS[\`search_products\` → \`completed\`: returned no values]\n\nENDING[\`lookup_customer\` → \`completed\`]\n`,
    );
  });

  it("gives a grounded step the results as one more step instruction, before the ending's facts", async () => {
    const prepare = vi.fn((_input: RoutineStepReplyInput) => ({ render: async () => ({ answer: "grounded" }) }));
    const renderer = new RoutineStepRenderer({ complete: vi.fn(async () => ({ text: "step reply" })) }, {
      stepToolResultsPromptTemplate: TOOLS_TEMPLATE,
      stepEndingPromptTemplate: ENDING_TEMPLATE,
      groundedAnswerRenderer: { render: vi.fn(), prepare },
    });

    await renderer.render({ step: finishEnding, steering: [routineRule(ENDING_TEXT)], turn, ending: lookupCompleted, skillResults: [noProducts] });

    expect(prepare.mock.calls[0][0].steering.map((rule) => rule.action)).toEqual([
      ENDING_TEXT,
      "TOOLS[`search_products` → `completed`: returned no values]",
      "ENDING[`lookup_customer` → `completed`]",
    ]);
  });

  it("leaves a presenting step's grounded steering to the host, which presents the results itself", async () => {
    const prepare = vi.fn((_input: RoutineStepReplyInput) => ({ render: async () => ({ answer: "cards" }) }));
    const presenting: RoutineStep = { ...confirmStep, present: { from: "search", selection: "single", slot: "chosen" } };
    const renderer = new RoutineStepRenderer({ complete: vi.fn(async () => ({ text: "step reply" })) }, {
      stepToolResultsPromptTemplate: TOOLS_TEMPLATE,
      groundedAnswerRenderer: { render: vi.fn(), prepare },
    });

    await renderer.render({ step: presenting, steering: [routineRule(confirmStep.action ?? "")], turn, skillResults: [noProducts] });

    expect(prepare.mock.calls[0][0].steering).toEqual([routineRule(confirmStep.action ?? "")]);
  });
});
