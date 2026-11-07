import { describe, expect, it } from "vitest";

import type {
  ConversationModelGateway,
  ConversationModelRequest,
  Routine,
  RoutineSkillResult,
  RoutineSlotSchema,
  RoutineState,
  RoutineStep,
  RoutineStepReplyInput,
  SteeringRule,
  TurnContext,
} from "@radioso/conversation-contract";
import { RoutineNextStepSelector, RoutineStepRenderer } from "../src/index.js";

/**
 * The exact model input the routine step renderer and next-step selector send, pinned for
 * representative turns. Wording that moves between code and prompt templates must leave
 * every byte of it alone.
 */

const recordingGateway = (text: string) => {
  const requests: ConversationModelRequest[] = [];
  const gateway: ConversationModelGateway = {
    complete: async (request) => {
      requests.push(request);
      return { text };
    },
  };
  return { gateway, requests };
};

const emailSlot: RoutineSlotSchema = { id: "slot_email", key: "email", type: "email", required: true };
const phoneSlot: RoutineSlotSchema = { id: "slot_phone", key: "phone", type: "text", required: false };

const turn: TurnContext = {
  agent: {
    id: "agent_1",
    name: "Retreat Desk",
    instructions: ["Help visitors book retreats.", "  Keep answers short.  "],
  },
  sessionId: "session_1",
  inputEvent: { id: "in_1", kind: "message", content: "I'd like the autumn one" },
  history: [
    { role: "user", content: "Do you have retreats in the autumn?" },
    { role: "assistant", content: "We do. Which edition suits you?" },
  ],
  stagedContext: [],
  steering: [],
};

const retrievalTurn: TurnContext = {
  ...turn,
  stagedContext: [{
    kind: "skill_result",
    source: "retrieval.context",
    data: {
      contexts: [
        { documentId: "doc_1", chunkId: "chunk_1", title: "Autumn retreat", content: "Runs 30 October to 2 November." },
        { content: "Arrive by 4pm on the first day." },
      ],
    },
  }],
};

const unresolvedTurn: TurnContext = {
  ...turn,
  metadata: { answerCoverage: { availability: "assessed", coverage: "unanswered" } },
};

const askContact: RoutineStep = {
  id: "ask_contact",
  kind: "chat",
  action: "Thank them, then ask for their email and phone number.",
  metadata: { collectsSlots: ["email", "phone"] },
};
const confirmed: RoutineStep = { id: "confirmed", kind: "terminal", action: "Confirm the booking request was sent." };

const routineRule = (action: string): SteeringRule => ({ action, source: "routine", lifespan: "response" });
const contactSteering: SteeringRule[] = [routineRule("Thank them, then ask for their email and phone number.")];
const directiveRule: SteeringRule = {
  action: "Use the visitor's first name when you know it.",
  source: "directive",
  lifespan: "response",
};

const pageEvidence = [
  "<page_excerpt>Autumn retreat: 30 October to 2 November.</page_excerpt>",
  "<page_context>https://example.test/retreats/autumn</page_context>",
];

const replyCases: Array<{ name: string; input: RoutineStepReplyInput; responseLanguage?: string }> = [
  { name: "a chat step reply with retrieved excerpts", input: { step: askContact, steering: contactSteering, turn: retrievalTurn } },
  {
    name: "a re-ask with slots still to ask for and page evidence",
    input: {
      step: askContact,
      steering: contactSteering,
      turn,
      reask: { missingSlots: [emailSlot, phoneSlot] },
      contextEvidence: pageEvidence,
    },
    responseLanguage: "Italian",
  },
  {
    name: "a re-ask with nothing listed as still to ask for",
    input: { step: askContact, steering: contactSteering, turn, reask: { missingSlots: [] } },
  },
  {
    name: "a re-ask past the limit with a slot still to ask for",
    input: { step: askContact, steering: contactSteering, turn, reask: { missingSlots: [emailSlot], exhausted: true } },
  },
  {
    name: "a re-ask past the limit with nothing listed as still to ask for",
    input: { step: askContact, steering: contactSteering, turn, reask: { missingSlots: [], exhausted: true } },
  },
  {
    name: "a terminal step reply",
    input: { step: confirmed, steering: [routineRule("Confirm the booking request was sent.")], turn },
    responseLanguage: "German",
  },
  {
    name: "a terminal step reply whose operators cannot be reached",
    input: { step: confirmed, steering: [routineRule("Confirm the booking request was sent.")], turn, operatorsUnreachable: true },
    responseLanguage: "German",
  },
  {
    name: "a chat step reply after an action step whose operators cannot be reached",
    input: { step: askContact, steering: contactSteering, turn, operatorsUnreachable: true },
  },
  {
    name: "a step reply on an unresolved request with directive guidance and one evidence block",
    input: {
      step: askContact,
      steering: [...contactSteering, directiveRule],
      turn: unresolvedTurn,
      contextEvidence: [pageEvidence[0]],
    },
  },
];

const datesRoutine: Routine = {
  id: "booking",
  rootStepId: "ask_dates",
  slots: [
    { id: "slot_arrival", key: "arrival", type: "date", required: true, description: "The day the visitor arrives." },
    { id: "slot_departure", key: "departure", type: "date", required: true, description: "The day\n  they   leave." },
    { id: "slot_program", key: "program", type: "text", required: true },
  ],
  steps: [
    { id: "ask_dates", kind: "chat", action: "Ask for {{slot.arrival}} and {{slot.departure}}.", metadata: { collectsSlots: ["arrival", "departure"] } },
    { id: "done", kind: "terminal", action: "Confirm." },
  ],
  transitions: [
    { from: "ask_dates", to: "done", condition: "The user provided {{slot.arrival}} and {{slot.departure}}." },
    { from: "ask_dates", to: "done", condition: "The user wants to stop." },
  ],
};

const contactRoutine: Routine = {
  id: "contact",
  rootStepId: "ask_contact",
  slots: [emailSlot, phoneSlot],
  steps: [{ id: "ask_contact", kind: "chat" }, { id: "done", kind: "terminal" }],
  transitions: [{ from: "ask_contact", to: "done", condition: "The user gave an email." }],
};

const lookupRoutine: Routine = {
  id: "lookup",
  rootStepId: "look_up",
  steps: [{ id: "look_up", kind: "skill", skillName: "orders.lookup" }, { id: "done", kind: "terminal" }],
  transitions: [
    { from: "look_up", to: "done", condition: "The order was found." },
    { from: "look_up", to: "done", condition: "No order matched." },
  ],
};

const stateOf = (routine: Routine, variables: Record<string, unknown>): RoutineState => ({
  sessionId: "session_1",
  routineId: routine.id,
  path: [routine.rootStepId],
  variables,
  status: "active",
});

const skillResult: RoutineSkillResult = { status: "completed", outputs: { order_status: "delivered" } };

const selectorCases: Array<{
  name: string;
  routine: Routine;
  variables: Record<string, unknown>;
  skillResult?: RoutineSkillResult;
}> = [
  { name: "date slots, one already held", routine: datesRoutine, variables: { arrival: "2026-10-30" } },
  { name: "slots without a date slot, none held", routine: contactRoutine, variables: {} },
  { name: "a skill step without slots", routine: lookupRoutine, variables: {}, skillResult },
];

describe("routine model input", () => {
  it.each(replyCases)("renders $name", async ({ input, responseLanguage }) => {
    const { gateway, requests } = recordingGateway("Grazie!");
    const renderer = new RoutineStepRenderer(gateway, responseLanguage ? { responseLanguage } : {});

    await renderer.render(input);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchSnapshot();
  });

  it.each(selectorCases)("selects with $name", async ({ routine, variables, skillResult: result }) => {
    const { gateway, requests } = recordingGateway('{"variables": {}, "claimsAuthority": false, "condition": null, "offTopic": false}');
    const selector = new RoutineNextStepSelector(gateway, { clock: () => new Date("2026-10-29T08:00:00Z") });
    const currentStep = routine.steps[0];

    await selector.select({
      routine,
      state: stateOf(routine, variables),
      currentStep,
      transitions: routine.transitions.filter((transition) => transition.from === currentStep.id),
      turn,
      ...(result ? { skillResult: result } : {}),
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchSnapshot();
  });
});
