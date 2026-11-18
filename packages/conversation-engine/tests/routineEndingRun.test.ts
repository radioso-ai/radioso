import { describe, expect, it, vi } from "vitest";

import { DefaultRoutineRunner } from "../src/routineRunner.js";
import type {
  ConversationRoutineSkillDispatcher,
  ConversationRoutineStepRenderer,
  Routine,
  RoutineSkillResult,
  RoutineState,
  RoutineStep,
  RoutineStepReplyInput,
  TurnContext,
} from "@radioso/conversation-contract";

/**
 * An ending's reply is told what the run did before it (#1820). A property-matching routine's
 * search found nothing, so nothing was shortlisted, and its ending still told the visitor a scout
 * "will check the shortlisted properties": the reply had only the authored ending text.
 */

const turn: TurnContext = {
  agent: { id: "agent_1", name: "Homes Desk" },
  sessionId: "session_1",
  inputEvent: { id: "in_1", kind: "message", content: "A quiet two-bedroom flat near a park, under 1,400 a month." },
  history: [],
  stagedContext: [],
  steering: [],
};

const handoffEnding: RoutineStep = {
  id: "scout",
  kind: "terminal",
  action: "Tell them a scout will check the shortlisted properties and get back to them.",
  metadata: { terminalKind: "handoff" },
};

const finishEnding: RoutineStep = {
  id: "done",
  kind: "terminal",
  action: "Tell them a scout will check the shortlisted properties.",
  metadata: { terminalKind: "complete" },
};

/** Brief → search → `ending`, where the turn answering the brief runs the search and reaches the ending. */
const searchRoutine = (ending: RoutineStep, overrides: Partial<Routine> = {}): Routine => ({
  id: "property_match",
  rootStepId: "ask_brief",
  steps: [
    { id: "ask_brief", kind: "chat", action: "Ask what kind of home they are looking for." },
    { id: "search", kind: "skill", skillName: "search_listings" },
    ending,
  ],
  transitions: [
    { from: "ask_brief", to: "search", condition: "The visitor described the home they want." },
    { from: "search", to: ending.id, condition: "The search ran." },
  ],
  ...overrides,
});

const state = (routine: Routine, path: string[]): RoutineState => ({
  sessionId: "session_1",
  routineId: routine.id,
  path,
  variables: {},
  status: "active",
});

const emptySearch: RoutineSkillResult = {
  status: "empty",
  outputs: { found: false, source_count: 0, contexts: [] },
  actsOutsideConversation: false,
};

/** Runs one turn from `path` with the selector moving to `nextStepId`, and returns what the renderer got. */
const replyInputFor = async (input: {
  routine: Routine;
  path: string[];
  nextStepId: string;
  results?: Record<string, RoutineSkillResult>;
  /** The dispatcher's static word on which skills can act outside the conversation; absent, it gives none. */
  actingOutside?: readonly string[];
}): Promise<RoutineStepReplyInput> => {
  const renderer: ConversationRoutineStepRenderer = { render: vi.fn(async () => ({ answer: "ok" })) };
  const dispatch: ConversationRoutineSkillDispatcher["dispatch"] = vi.fn(async ({ skillName }) => {
    const result = input.results?.[skillName];
    if (!result) {
      throw new Error(`no result scripted for ${skillName}`);
    }
    return result;
  });
  const actingOutside = input.actingOutside;
  const dispatcher: ConversationRoutineSkillDispatcher = actingOutside
    ? { dispatch, actsOutsideConversation: (skillName) => actingOutside.includes(skillName) }
    : { dispatch };
  const runner = new DefaultRoutineRunner(
    [input.routine],
    { select: vi.fn(async () => ({ nextStepId: input.nextStepId })) },
    renderer,
    dispatcher,
  );

  await runner.resume({ turn, state: state(input.routine, input.path) });

  expect(renderer.render).toHaveBeenCalledTimes(1);
  return vi.mocked(renderer.render).mock.calls[0][0];
};

describe("DefaultRoutineRunner tells an ending's reply what the run did (#1820)", () => {
  it("reports a search that found nothing to the hand-off ending after it", async () => {
    const input = await replyInputFor({
      routine: searchRoutine(handoffEnding),
      path: ["ask_brief"],
      nextStepId: "search",
      results: { search_listings: emptySearch },
    });

    expect(input.step.id).toBe("scout");
    expect(input.ending).toEqual({
      requestPassedOn: true,
      skillOutcomes: [{ skillName: "search_listings", status: "empty" }],
    });
  });

  it("reports that a finish ending passes nothing on when no step or ending tells anyone", async () => {
    const input = await replyInputFor({
      routine: searchRoutine(finishEnding),
      path: ["ask_brief"],
      nextStepId: "search",
      results: { search_listings: emptySearch },
    });

    expect(input.ending).toEqual({
      requestPassedOn: false,
      skillOutcomes: [{ skillName: "search_listings", status: "empty" }],
    });
  });

  it("counts a finish ending that notifies operators as passing the request on", async () => {
    const notifying: RoutineStep = {
      ...finishEnding,
      metadata: { terminalKind: "complete", operatorNotice: { subject: "New brief" } },
    };

    const input = await replyInputFor({
      routine: searchRoutine(notifying),
      path: ["ask_brief"],
      nextStepId: "search",
      results: { search_listings: emptySearch },
    });

    expect(input.ending?.requestPassedOn).toBe(true);
  });

  it("counts a finish ending whose completion export fires as passing the request on", async () => {
    const input = await replyInputFor({
      routine: searchRoutine(finishEnding, {
        completionExport: { enabled: true, triggerKinds: ["complete"], destinationRef: "crm_leads" },
      }),
      path: ["ask_brief"],
      nextStepId: "search",
      results: { search_listings: emptySearch },
    });

    expect(input.ending?.requestPassedOn).toBe(true);
  });

  it("counts a tool step that may have acted outside the conversation, with the status it reported", async () => {
    const input = await replyInputFor({
      routine: searchRoutine(finishEnding),
      path: ["ask_brief"],
      nextStepId: "search",
      results: { search_listings: { status: "completed", outputs: { sent: true } } },
    });

    expect(input.ending).toEqual({
      requestPassedOn: true,
      skillOutcomes: [{ skillName: "search_listings", status: "completed" }],
    });
  });

  it("counts an action step the run emitted on the way to the ending", async () => {
    const routine: Routine = {
      id: "property_match",
      rootStepId: "ask_brief",
      steps: [
        { id: "ask_brief", kind: "chat", action: "Ask what kind of home they are looking for." },
        { id: "record_brief", kind: "action", actionType: "brief.recorded" },
        finishEnding,
      ],
      transitions: [
        { from: "ask_brief", to: "record_brief", condition: "The visitor described the home they want." },
        { from: "record_brief", to: "done", condition: "Recorded." },
      ],
    };

    const input = await replyInputFor({ routine, path: ["ask_brief"], nextStepId: "record_brief" });

    expect(input.ending).toEqual({ requestPassedOn: true, skillOutcomes: [] });
  });

  it("counts no tool step that failed, though its skill may have acted outside the conversation", async () => {
    // A ticket webhook that answered 500: the reply must not say the team will email them.
    const input = await replyInputFor({
      routine: searchRoutine(finishEnding),
      path: ["ask_brief"],
      nextStepId: "search",
      results: { search_listings: { status: "failed", outputs: { reason: "http_500" }, actsOutsideConversation: true } },
    });

    expect(input.ending).toEqual({
      requestPassedOn: false,
      skillOutcomes: [{ skillName: "search_listings", status: "failed" }],
    });
  });

  // The issue's shape across turns: the search ran and its results were shown on turn one, and the
  // visitor's answer reaches a finish that tells no one on turn two.
  const shownThenFinished: Routine = {
    id: "property_match",
    rootStepId: "ask_brief",
    steps: [
      { id: "ask_brief", kind: "chat", action: "Ask what kind of home they are looking for." },
      { id: "search", kind: "skill", skillName: "search_listings" },
      { id: "show", kind: "chat", action: "Show the homes that match and ask which one they like." },
      finishEnding,
    ],
    transitions: [
      { from: "ask_brief", to: "search", condition: "The visitor described the home they want." },
      { from: "search", to: "show", condition: "The search ran." },
      { from: "show", to: "done", condition: "They answered." },
    ],
  };

  it("counts no search an earlier turn ran as passing the request on", async () => {
    const input = await replyInputFor({ routine: shownThenFinished, path: ["ask_brief", "search", "show"], nextStepId: "done", actingOutside: [] });

    expect(input.ending).toEqual({ requestPassedOn: false, skillOutcomes: [] });
  });

  it("counts no tool step an earlier turn ran when the dispatcher cannot say what its skill does", async () => {
    const input = await replyInputFor({ routine: shownThenFinished, path: ["ask_brief", "search", "show"], nextStepId: "done" });

    expect(input.ending).toEqual({ requestPassedOn: false, skillOutcomes: [] });
  });

  it("counts a tool step an earlier turn ran when its skill acts outside the conversation", async () => {
    const input = await replyInputFor({
      routine: shownThenFinished,
      path: ["ask_brief", "search", "show"],
      nextStepId: "done",
      actingOutside: ["search_listings"],
    });

    expect(input.ending).toEqual({ requestPassedOn: true, skillOutcomes: [] });
  });

  it.each([
    { kind: "action", step: { id: "earlier", kind: "action", actionType: "brief.recorded" } },
    { kind: "approval", step: { id: "earlier", kind: "await", decision: { captureKey: "review", options: [] } } },
  ] satisfies Array<{ kind: string; step: RoutineStep }>)(
    "counts an $kind step an earlier turn ran, and lists no outcome for it",
    async ({ step }) => {
      const routine: Routine = {
        id: "property_match",
        rootStepId: "earlier",
        steps: [step, { id: "ask_more", kind: "chat", action: "Ask if there is anything else." }, finishEnding],
        transitions: [
          { from: "earlier", to: "ask_more", condition: "Done." },
          { from: "ask_more", to: "done", condition: "Nothing else." },
        ],
      };

      const input = await replyInputFor({ routine, path: ["earlier", "ask_more"], nextStepId: "done" });

      expect(input.ending).toEqual({ requestPassedOn: true, skillOutcomes: [] });
    },
  );

  it("gives a chat step's reply no ending", async () => {
    const routine: Routine = {
      ...searchRoutine(finishEnding),
      steps: [
        { id: "ask_brief", kind: "chat", action: "Ask what kind of home they are looking for." },
        { id: "search", kind: "skill", skillName: "search_listings" },
        { id: "show", kind: "chat", action: "Show the homes that match and ask which one they like." },
        finishEnding,
      ],
      transitions: [
        { from: "ask_brief", to: "search", condition: "The visitor described the home they want." },
        { from: "search", to: "show", condition: "The search ran." },
        { from: "show", to: "done", condition: "They picked one." },
      ],
    };

    const input = await replyInputFor({
      routine,
      path: ["ask_brief"],
      nextStepId: "search",
      results: { search_listings: emptySearch },
    });

    expect(input.step.id).toBe("show");
    expect(input).not.toHaveProperty("ending");
  });
});
