import { describe, expect, it, vi } from "vitest";

import type { RoutineStep, StagedContext, TurnContext } from "@radioso/conversation-contract";

import type { ChatGateway, ChatGatewayInput } from "../../../../src/modules/chat/contracts/chatGateway.js";
import { ChatAnswerPresenter } from "../../../../src/modules/chat/services/chatAnswerPresenter.js";
import { buildChatTurnRuntime } from "../../../../src/modules/chat/services/chatTurnRuntime.js";
import type { PreparedSession } from "../../../../src/modules/chat/services/chatSessionPreparer.js";
import { SkillResultReplyBlocks } from "../../../../src/modules/chat/services/replyBlocks/skillResultReplyBlocks.js";
import {
  createRoutineGroundedAnswerRenderer,
  presentRoutineRenderableAnswer,
} from "../../../../src/modules/chat/services/routines/routineGroundedAnswerRenderer.js";
import { AssistantSuggestionExpansionService } from "../../../../src/modules/chat/services/assistantSuggestionExpansionService.js";

// A routine step that shows a skill step's results (#1763, US7): the host writes it from the
// records its source staged, offers the cards where the gate opens, and lists them in text where
// it is shut. The step's binding, never the model, decides the selection and the stored origin.

const HOMES = [
  { id: "h-1", name: "Casa Blu", area: "Mitte", url: "https://homes.example/casa-blu", photo: "https://img.homes.example/casa-blu.jpg" },
  { id: "h-2", name: "Villa Rosa", area: "Mitte", url: "https://homes.example/villa-rosa", photo: "https://img.homes.example/villa-rosa.jpg" },
];

const ENVELOPE = JSON.stringify({
  present: { records: ["r2", "r1"], fields: { title: "/name", subtitle: "/area", image: "/photo", link: "/url" }, caption: "Homes in Mitte" },
  answer: "Two homes match; pick the one you like.",
});
const TEXT_LIST = "Two homes match:\n1. Casa Blu\n2. Villa Rosa\nWhich one do you like?";
const LIST_ENVELOPE = JSON.stringify({
  present: { records: ["r1", "r2"], fields: { title: "/name", subtitle: "/area", image: "/photo", link: "/url" }, caption: "Homes in Mitte" },
  answer: TEXT_LIST,
});

const session = (replyCardsEnabled: boolean, declared = true): PreparedSession => ({
  agent: { id: "agent-1", workspaceId: "workspace-1", name: "Nico", chatModelOverride: null, replyCardsEnabled },
  conversation: { id: "conversation-1", workspaceId: "workspace-1", sourceChannel: "widget" },
  userMessage: { id: "message-1", content: "Mitte, up to 2,000" },
  effectiveQuery: "Mitte, up to 2,000",
  history: [],
  turnRoute: "retrieval",
  retrieval: { responseIdentity: null, responseSettings: { customInstruction: "Help visitors find a home." } },
  resolvedContext: { snapshot: {}, fragments: [], renderFragments: [], staged: [] },
  directiveSteering: { rules: [], omissions: [], matches: [] },
  replyBlocks: declared ? { item_list: { layouts: ["carousel", "list"] } } : null,
  turnTrace: { traceId: "trace-1", startedAt: new Date(0).toISOString(), stages: [] },
} as unknown as PreparedSession);

const choose: RoutineStep = {
  id: "choose",
  kind: "chat",
  action: "Show the matching homes and ask which one they like.",
  present: { from: "search", selection: "single", slot: "chosen_home" },
};

const staged = (over: Partial<StagedContext> = {}, metadata: Record<string, unknown> = {}): StagedContext => ({
  kind: "skill_result",
  source: "search_homes",
  data: { structuredContent: { results: HOMES } },
  metadata: { stepId: "search", status: "completed", ...metadata },
  ...over,
});

const turn = (stagedContext: StagedContext[]): TurnContext => ({
  agent: { id: "agent-1", name: "Nico" },
  sessionId: "conversation-1",
  inputEvent: { id: "message-1", kind: "message", content: "Mitte, up to 2,000" },
  history: [],
  stagedContext,
  steering: [],
  activeRoutineId: "routine-homes",
  activeStepId: "choose",
});

const setup = (replyCardsEnabled: boolean, declared = true) => {
  const calls: ChatGatewayInput[] = [];
  const gateway: ChatGateway = {
    async answer(input) {
      calls.push(input);
      return input.prompt.includes("Listed records") ? LIST_ENVELOPE : ENVELOPE;
    },
    async *streamAnswer(input) {
      calls.push(input);
      yield input.prompt.includes("Listed records") ? LIST_ENVELOPE : ENVELOPE;
    },
  };
  const runtime = buildChatTurnRuntime({
    chatGateway: gateway,
    fallbackReplyComposer: { composeNoContext: vi.fn() },
    skillOutcomeCapabilities: { supportsGroundedAnswer: () => false },
    skillResultReplyBlocks: new SkillResultReplyBlocks({
      imageUrls: { forImage: (imageId) => ({ src: `https://api.example/images/${imageId}`, srcSet: "" }) },
      newImageId: (() => { let next = 0; return () => `image-${++next}`; })(),
    }),
  });
  const metrics = { incrementCounter: vi.fn() };
  const renderer = createRoutineGroundedAnswerRenderer({
    session: session(replyCardsEnabled, declared),
    turnSkills: runtime.turnSkills,
    presentingSteps: { skillResultRenderer: runtime.skillResultRenderer, metrics },
    chatAnswerPresenter: runtime.chatAnswerPresenter,
  });
  const outcomes = () => metrics.incrementCounter.mock.calls.map(([name, options]) => [name, (options as { labels: { outcome: string } }).labels.outcome]);
  return { renderer, calls, outcomes };
};

const presenter = new ChatAnswerPresenter(new AssistantSuggestionExpansionService());

describe("a routine step that shows a skill step's results (#1763)", () => {
  it("offers cards from the staged records, picked into the step's slot and stored with the step's run as their origin", async () => {
    const { renderer, calls, outcomes } = setup(true);

    const reply = await renderer.prepare!({ step: choose, steering: [], turn: { ...turn([staged()]), activeRoutineExecutionId: "run-1" } })!.render();
    const presentation = presentRoutineRenderableAnswer(presenter, reply);

    expect(reply.answer).toBe("Two homes match; pick the one you like.");
    expect(calls[0]?.prompt).toContain("[r2]");
    const stored = presentation.replyBlocks?.stored[0];
    expect(stored).toMatchObject({
      selection: "single",
      origin: { kind: "routine_step", skillName: "search_homes", routineId: "routine-homes", stepId: "choose", executionId: "run-1", slot: "chosen_home" },
    });
    expect(outcomes()).toEqual([["routine_present_total", "cards"]]);
    expect(stored?.items.map((item) => [item.title, item.fields?.id])).toEqual([["Villa Rosa", "h-2"], ["Casa Blu", "h-1"]]);
    expect(presentation.replyBlocks?.presented[0]?.items[0]?.actions).toEqual([
      { type: "open", url: "https://homes.example/villa-rosa" },
      { type: "select" },
    ]);
    // The cards' pictures ride with the blocks, for the reply's transaction to record.
    expect(presentation.replyBlocks?.toolImages).toEqual([
      { imageId: "image-1", url: "https://img.homes.example/villa-rosa.jpg" },
      { imageId: "image-2", url: "https://img.homes.example/casa-blu.jpg" },
    ]);
  });

  it("streams the same reply with its cards", async () => {
    const { renderer } = setup(true);

    const pending = renderer.prepare!({ step: choose, steering: [], turn: turn([staged()]) })!;
    const stream = pending.stream!();
    let step = await stream.next();
    const shown: string[] = [];
    while (!step.done) {
      shown.push(step.value);
      step = await stream.next();
    }
    expect(shown.join("")).toBe("Two homes match; pick the one you like.");
    expect(step.value.blocks?.[0]?.selection).toBe("single");
  });

  it.each([
    ["the agent's cards switch is off", false, true],
    ["the client draws no cards", true, false],
  ])("lists the records in text when %s, and keeps what it listed, unpresented", async (_label, enabled, declared) => {
    const { renderer, calls, outcomes } = setup(enabled, declared);

    const reply = await renderer.prepare!({ step: choose, steering: [], turn: turn([staged()]) })!.render();
    const presentation = presentRoutineRenderableAnswer(presenter, reply);

    expect(reply.answer).toBe(TEXT_LIST);
    expect(reply.blocks).toBeUndefined();
    expect(presentation.replyBlocks).toBeUndefined();
    expect(calls[0]?.prompt).toContain("Listed records");
    expect(calls[0]?.prompt).toContain("[r1]");
    expect(presentation.listedItems).toMatchObject({
      selection: "none",
      layout: "list",
      origin: { kind: "routine_step", stepId: "choose", slot: "chosen_home" },
    });
    expect(presentation.listedItems?.items.map((item) => [item.title, item.image, item.fields?.id])).toEqual([
      ["Casa Blu", undefined, "h-1"],
      ["Villa Rosa", undefined, "h-2"],
    ]);
    expect(outcomes()).toEqual([["routine_present_total", "text"]]);
  });

  it.each([
    ["the source did not run this turn", []],
    ["the source failed", [staged({}, { status: "failed" })]],
    ["the source returned nothing", [staged({ data: {} })]],
    ["another step's result is staged", [staged({}, { stepId: "lookup" })]],
  ])("leaves the step its own reply when %s", (_label, stagedContext) => {
    const { renderer, outcomes } = setup(true);

    expect(renderer.prepare!({ step: choose, steering: [], turn: turn(stagedContext) })).toBeNull();
    expect(outcomes()).toHaveLength(1);
  });

  it("leaves a step with no binding to its own reply", () => {
    const { renderer } = setup(true);
    const { present: _present, ...plain } = choose;

    expect(renderer.prepare!({ step: plain, steering: [], turn: turn([staged()]) })).toBeNull();
  });
});
