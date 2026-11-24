import { describe, expect, it, vi } from "vitest";

import { DefaultRoutineRunner } from "../src/routineRunner.js";
import { stagedContextForSkillResult, turnSkillResults } from "../src/routineStepContext.js";
import type {
  ConversationRoutineSkillDispatcher,
  ConversationRoutineStepRenderer,
  Routine,
  RoutineSkillResult,
  RoutineState,
  RoutineStep,
  RoutineStepReplyInput,
  SkillOutputContract,
  TurnContext,
} from "@radioso/conversation-contract";

/**
 * A step rendered after a tool step on the same turn reads what the tool returned (#1883). A
 * customer lookup completed and assigned the customer's name, and the ending that was to tell the
 * visitor the name said nothing was found: its reply heard only `lookup_customer → completed`.
 */

const turn: TurnContext = {
  agent: { id: "agent_1", name: "Shop Desk" },
  sessionId: "session_1",
  inputEvent: { id: "in_1", kind: "message", content: "Customer 5, please." },
  history: [],
  stagedContext: [],
  steering: [],
};

const customerContract: SkillOutputContract = {
  first_name: { type: "text", description: "First name" },
  city: { type: "text", description: "City" },
};

const foundCustomer: RoutineSkillResult = {
  status: "completed",
  // `internal` is not declared: it never reaches a reply.
  outputs: { first_name: "Emily", city: "Phoenix", internal: "row-17" },
  outputContract: customerContract,
  actsOutsideConversation: false,
};

const done: RoutineStep = {
  id: "done",
  kind: "terminal",
  action: "Tell the visitor the customer's first name and city that the lookup returned.",
  metadata: { terminalKind: "complete" },
};

/** Number → lookup → `after`, where the turn answering the number runs the lookup and reaches `after`. */
const lookupRoutine = (after: RoutineStep, extra: { steps?: RoutineStep[]; transitions?: Routine["transitions"] } = {}): Routine => ({
  id: "customer_lookup",
  rootStepId: "ask_number",
  steps: [
    { id: "ask_number", kind: "chat", action: "Ask for the customer number." },
    {
      id: "lookup",
      kind: "skill",
      skillName: "lookup_customer",
      outputAssignments: { first_name: "first_name", city: "city" },
    },
    after,
    ...(extra.steps ?? []),
  ],
  transitions: [
    { from: "ask_number", to: "lookup", condition: "The visitor gave a customer number." },
    { from: "lookup", to: after.id, condition: "The lookup ran." },
    ...(extra.transitions ?? []),
  ],
});

const state = (routine: Routine, path: string[], variables: Record<string, unknown> = {}): RoutineState => ({
  sessionId: "session_1",
  routineId: routine.id,
  path,
  variables,
  status: "active",
});

/** Runs one turn from `path`, the selector moving to `nextStepId`, and returns what the renderer got. */
const replyInputFor = async (input: {
  routine: Routine;
  path: string[];
  nextStepId: string;
  variables?: Record<string, unknown>;
  result?: RoutineSkillResult;
}): Promise<RoutineStepReplyInput> => {
  const renderer: ConversationRoutineStepRenderer = { render: vi.fn(async () => ({ answer: "ok" })) };
  const dispatcher: ConversationRoutineSkillDispatcher = {
    dispatch: vi.fn(async () => {
      if (!input.result) {
        throw new Error("no result scripted");
      }
      return input.result;
    }),
  };
  const runner = new DefaultRoutineRunner(
    [input.routine],
    { select: vi.fn(async () => ({ nextStepId: input.nextStepId })) },
    renderer,
    dispatcher,
  );

  await runner.resume({ turn, state: state(input.routine, input.path, input.variables) });

  expect(renderer.render).toHaveBeenCalledTimes(1);
  return vi.mocked(renderer.render).mock.calls[0][0];
};

describe("DefaultRoutineRunner gives a step what this turn's tool steps returned (#1883)", () => {
  it("gives the ending after a lookup its declared outputs, beside the outcome the ending already hears", async () => {
    const input = await replyInputFor({ routine: lookupRoutine(done), path: ["ask_number"], nextStepId: "lookup", result: foundCustomer });

    expect(input.step.id).toBe("done");
    expect(input.skillResults).toEqual([
      { skillName: "lookup_customer", status: "completed", outputs: { first_name: "Emily", city: "Phoenix" }, outputContract: customerContract },
    ]);
    expect(input.ending?.skillOutcomes).toEqual([{ skillName: "lookup_customer", status: "completed" }]);
  });

  it("gives an ordinary chat step after the lookup the same results", async () => {
    const confirm: RoutineStep = { id: "confirm", kind: "chat", action: "Ask whether this is the right customer." };
    const input = await replyInputFor({
      routine: lookupRoutine(confirm, { steps: [done], transitions: [{ from: "confirm", to: "done", condition: "Confirmed." }] }),
      path: ["ask_number"],
      nextStepId: "lookup",
      result: foundCustomer,
    });

    expect(input.step.id).toBe("confirm");
    expect(input.skillResults).toEqual([
      { skillName: "lookup_customer", status: "completed", outputs: { first_name: "Emily", city: "Phoenix" }, outputContract: customerContract },
    ]);
    expect(input.ending).toBeUndefined();
  });

  it("gives nothing new for a skill without an output contract: the ending hears its outcome as before", async () => {
    const input = await replyInputFor({
      routine: lookupRoutine(done),
      path: ["ask_number"],
      nextStepId: "lookup",
      result: { status: "completed", outputs: { structuredContent: { first_name: "Emily" } } },
    });

    expect(input).not.toHaveProperty("skillResults");
    expect(input.ending).toEqual({
      requestPassedOn: true,
      skillOutcomes: [{ skillName: "lookup_customer", status: "completed" }],
    });
  });

  it("gives nothing for a lookup that found nothing: its outcome carries no contract", async () => {
    const input = await replyInputFor({
      routine: lookupRoutine(done),
      path: ["ask_number"],
      nextStepId: "lookup",
      result: { status: "not_found", outputs: {}, actsOutsideConversation: false },
    });

    expect(input).not.toHaveProperty("skillResults");
    expect(input.ending?.skillOutcomes).toEqual([{ skillName: "lookup_customer", status: "not_found" }]);
  });

  it("fills a reference to a variable a skill output assigned on the same turn", async () => {
    const referencing: RoutineStep = { ...done, action: "Greet {{slot.first_name}} from {{slot.city}}." };
    const input = await replyInputFor({ routine: lookupRoutine(referencing), path: ["ask_number"], nextStepId: "lookup", result: foundCustomer });

    expect(input.step.action).toBe("Greet Emily from Phoenix.");
  });

  it("gives a step on a later turn no results, while a reference to the assigned variable still fills", async () => {
    const confirm: RoutineStep = { id: "confirm", kind: "chat", action: "Ask whether this is the right customer." };
    const referencing: RoutineStep = { ...done, action: "Thank {{slot.first_name}} from {{slot.city}}." };
    const routine = lookupRoutine(confirm, {
      steps: [referencing],
      transitions: [{ from: "confirm", to: "done", condition: "Confirmed." }],
    });

    const input = await replyInputFor({
      routine,
      path: ["ask_number", "lookup", "confirm"],
      nextStepId: "done",
      variables: { customer_id: 5, first_name: "Emily", city: "Phoenix" },
    });

    expect(input.step.id).toBe("done");
    expect(input).not.toHaveProperty("skillResults");
    expect(input.step.action).toBe("Thank Emily from Phoenix.");
  });
});

describe("turnSkillResults", () => {
  const lookup: RoutineStep = { id: "lookup", kind: "skill", skillName: "lookup_customer" };
  const search: RoutineStep = { id: "search", kind: "skill", skillName: "search_products" };
  const productContract: SkillOutputContract = {
    products: { type: "list", fields: { title: { type: "text", role: "title" } } },
  };
  const staged = (step: RoutineStep, result: RoutineSkillResult) => stagedContextForSkillResult(step, result)!;

  it("keeps one result per step, the latest, in the order the steps last ran", () => {
    const first = staged(lookup, { ...foundCustomer, outputs: { first_name: "Ann" } });
    const products = staged(search, { status: "completed", outputs: { products: [{ title: "Phone" }] }, outputContract: productContract });
    const again = staged(lookup, foundCustomer);

    expect(turnSkillResults([first, products, again])).toEqual([
      { skillName: "search_products", status: "completed", outputs: { products: [{ title: "Phone" }] }, outputContract: productContract },
      { skillName: "lookup_customer", status: "completed", outputs: { first_name: "Emily", city: "Phoenix" }, outputContract: customerContract },
    ]);
  });

  it("leaves out a result without a contract, and context nothing in the walk staged", () => {
    expect(turnSkillResults([
      staged(lookup, { status: "completed", outputs: { first_name: "Emily" } }),
      { kind: "skill_result", source: "lookup_customer", data: { first_name: "Emily" }, metadata: { status: "completed", outputContract: customerContract } },
      { kind: "retrieval", source: "retrieval.context", data: { contexts: [] } },
    ])).toEqual([]);
  });
});
