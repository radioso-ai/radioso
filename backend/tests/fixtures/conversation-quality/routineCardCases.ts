import type { ConversationQualityCase } from "../../../src/modules/eval/suite/index.js";
import type { RoutineDefinitionDraftInput } from "../../../src/modules/routines/public.js";
import { replyBlocksCapabilities } from "./replyBlockCases.js";
import { TOOL_CARD_SKILL_NAME } from "./toolCardCases.js";

/**
 * A routine that shows a skill step's results as cards (#1763, US7): the invented letting agency's
 * viewing request. A brief collects the area and budget, a tool step runs the stub catalog search
 * (`toolCardCases.ts`), and the next step shows the homes as cards the visitor picks from, into an
 * `item` field a later step names. It runs on an agent of its own, with no directive, so the
 * routine claims the turn. The pick itself is covered by the live verify
 * (`tests/live/routine-present-pick.verify.test.ts`) and the Postgres integration test.
 */
export const PROPERTY_FLOW_ROUTINE_ID = "routine:cq-routine-cards:property-flow:v1";

const edge = (fromStep: string, toRef: string, ordinal: number): RoutineDefinitionDraftInput["transitions"][number] =>
  ({ fromStep, toRef, guardKind: "default", guardText: null, outcomeStatus: null, counterLimit: null, ordinal });

export const propertyFlowRoutine: RoutineDefinitionDraftInput & { id: string } = {
  id: PROPERTY_FLOW_ROUTINE_ID,
  name: "arrange-a-viewing",
  enabled: true,
  activation: {
    triggerDescription: "The visitor wants to arrange a viewing of a home to rent.",
    gateRef: null,
    priority: 10,
    reentryMode: "once_per_conversation",
  },
  slots: [
    { stableSlotId: "area", key: "area", type: "text", required: true, description: "The area they want to live in", ordinal: 0 },
    { stableSlotId: "budget", key: "budget", type: "number", required: true, description: "Their monthly rent budget", ordinal: 1 },
    { stableSlotId: "chosen_home", key: "chosen_home", type: "item", required: true, description: "The home they want to view", ordinal: 2 },
    { stableSlotId: "email", key: "email", type: "email", required: true, description: "Their email address", ordinal: 3 },
  ],
  steps: [
    { stableStepId: "brief", kind: "chat", instruction: "Ask which area they want to live in {{slot.area}} and their monthly budget {{slot.budget}}.", toolRef: null, ordinal: 0, metadata: {} },
    { stableStepId: "search", kind: "tool", instruction: "Search the homes.", toolRef: TOOL_CARD_SKILL_NAME, ordinal: 1, metadata: {} },
    {
      stableStepId: "choose",
      kind: "chat",
      instruction: "Show the homes within their budget and ask which one they would like to view.",
      toolRef: null,
      ordinal: 2,
      metadata: { present: { from: "search", selection: "single", slot: "chosen_home" } },
    },
    { stableStepId: "contact", kind: "chat", instruction: "Confirm that they chose {{slot.chosen_home}}, naming it, and ask for their email address {{slot.email}}.", toolRef: null, ordinal: 3, metadata: {} },
  ],
  transitions: [edge("brief", "search", 0), edge("search", "choose", 1), edge("choose", "contact", 2), edge("contact", "handoff", 3)],
  terminals: [{ stableStepId: "handoff", kind: "handoff", instruction: "Tell them an agent will email them about the viewing.", ordinal: 0 }],
};

const BUDGET = 2_000;

export const routineCardCases: ConversationQualityCase[] = [
  {
    id: "routine-property-flow",
    name: "A routine step shows a search's results as cards the visitor can pick",
    description: "A visitor asks to arrange a viewing of a flat in Mitte within a budget. The routine reads the area and budget, runs the stub catalog search, and lands on the step that shows the results: its reply is a short lead and a carousel of listings within the budget, each one a card the visitor can pick.",
    tags: ["tool-cards", "reply-blocks", "routine"],
    query: `I'd like to arrange a viewing of a flat in Mitte, up to ${BUDGET.toLocaleString("en")} a month.`,
    clientContextCapabilities: replyBlocksCapabilities,
    assertions: [
      { type: "turn_activates_routine", routineId: PROPERTY_FLOW_ROUTINE_ID },
      { type: "routine_step_reached", routineId: PROPERTY_FLOW_ROUTINE_ID, stepId: "choose" },
      { type: "reply_block", layout: "carousel", minItems: 2 },
      { type: "answer_excludes_image_url" },
    ],
  },
];
