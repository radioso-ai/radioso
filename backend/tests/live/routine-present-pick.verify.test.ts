/**
 * LIVE verification (not part of CI) for #1763 US7, the property flow: a routine collects a brief,
 * a tool step searches with it, a step shows the results as cards, the visitor picks one, the pick
 * fills the step's item slot, and the next step names the picked home. Everything but the model is
 * production code: the compiled routine, the engine's runner, the next-step selector and step
 * renderer with the shipped prompts, the host's presenting-step renderer, the skill-result composer
 * and its cards, and the pick read from the stored block. The search is the invented letting
 * agency's stub tool (`tests/fixtures/conversation-quality/toolCardCases.ts`, `.example` records).
 *
 * Four cases, three samples each, all aiming at the second item the step showed:
 * - tap: the client draws cards, and the visitor taps the second card.
 * - typed_title: the visitor types the second card's exact title.
 * - typed_second: the visitor types "the second one" after the cards.
 * - cards_off: the agent's cards switch is off; the step lists the homes in text, and the visitor
 *   types "the second one".
 * Each must fill the slot with the stored item, link included, and the next step must name it.
 *
 * Run with:
 *   cd backend && pnpm exec vitest run tests/live/routine-present-pick.verify.test.ts --disableConsoleIntercept
 *
 * Reads OPENAI_API_KEY from the environment, else from the nearest `.env` above this file. Skips
 * itself when absent.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ConversationMessage, RoutineState, TurnContext } from "@radioso/conversation-contract";
import { RoutineNextStepSelector, RoutineStepRenderer } from "@radioso/conversation-defaults";
import { DefaultRoutineRunner } from "@radioso/conversation-engine";

import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";
import type { ChatGateway, ChatGatewayInput } from "../../src/modules/chat/contracts/chatGateway.js";
import { buildChatTurnRuntime } from "../../src/modules/chat/services/chatTurnRuntime.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";
import { readItemSelection, routineItemSelectionOf } from "../../src/modules/chat/services/replyBlocks/itemSelection.js";
import { latestRoutinePresentation } from "../../src/modules/chat/services/replyBlocks/routinePresentation.js";
import { SkillResultReplyBlocks } from "../../src/modules/chat/services/replyBlocks/skillResultReplyBlocks.js";
import { RoutineChatModelGateway } from "../../src/modules/chat/services/routines/routineChatModelGateway.js";
import {
  createRoutineGroundedAnswerRenderer,
  presentRoutineRenderableAnswer,
} from "../../src/modules/chat/services/routines/routineGroundedAnswerRenderer.js";
import { compileRoutineDefinition } from "../../src/modules/routines/compiler.js";
import type { RoutineDefinition } from "../../src/modules/routines/domain.js";
import { loadPromptTemplate } from "../../src/shared/infra/prompts/promptLoader.js";
import { TOOL_CARD_LISTINGS_QUERY, toolCardStubTool } from "../fixtures/conversation-quality/toolCardCases.js";

/** The key from the environment, else from the nearest `.env` above this file that has one (a worktree's checkout has none of its own). */
const apiKey = process.env.OPENAI_API_KEY ?? (() => {
  for (let dir = path.dirname(fileURLToPath(import.meta.url)); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    try {
      const key = /^OPENAI_API_KEY=(\S+)/m.exec(readFileSync(path.join(dir, ".env"), "utf8"))?.[1];
      if (key) return key;
    } catch {
      continue;
    }
  }
  return undefined;
})();

const MODEL = "gpt-5.4-mini";
const SAMPLES = 3;
const CONVERSATION_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

const complete = async (input: { systemPrompt?: string; prompt: string; responseFormat?: unknown }): Promise<string> => {
  const format = input.responseFormat as { name: string; strict: boolean; schema: unknown } | undefined;
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      reasoning_effort: "low",
      messages: [
        ...(input.systemPrompt ? [{ role: "system", content: input.systemPrompt }] : []),
        { role: "user", content: input.prompt },
      ],
      ...(format ? { response_format: { type: "json_schema", json_schema: { name: format.name, strict: format.strict, schema: format.schema } } } : {}),
    }),
  });
  const json = (await response.json()) as { choices?: Array<{ message: { content: string } }>; error?: { message?: string } };
  if (!json.choices) {
    throw new Error(`model call failed: ${json.error?.message ?? response.status}`);
  }
  return json.choices[0].message.content;
};

/** The production gateway's call on the chat completions API: the system prompt, the prompt, and the strict schema. */
const liveGateway: ChatGateway = {
  async answer(input: ChatGatewayInput) {
    return complete({ systemPrompt: input.systemPrompt, prompt: input.prompt, responseFormat: input.generation?.responseFormat });
  },
  async *streamAnswer(input: ChatGatewayInput) {
    yield await liveGateway.answer(input);
  },
};

const edge = (fromStep: string, toRef: string, ordinal: number): RoutineDefinition["transitions"][number] =>
  ({ fromStep, toRef, guardKind: "default", guardText: null, ordinal });

/** Brief → search → show the homes and pick one → confirm the pick and ask for an email → hand-off. */
const definition: RoutineDefinition = {
  id: "routine-homes",
  agentId: "agent-1",
  lineageId: "lineage-homes",
  name: "find-a-home",
  version: 1,
  enabled: true,
  activation: { triggerDescription: "The visitor is looking for a home to rent.", gateRef: null, priority: 10, reentryMode: "once_per_conversation" },
  slots: [
    { stableSlotId: "area", key: "area", type: "text", required: true, description: "The area they want to live in", ordinal: 0 },
    { stableSlotId: "budget", key: "budget", type: "number", required: true, description: "Their monthly rent budget", ordinal: 1 },
    { stableSlotId: "chosen_home", key: "chosen_home", type: "item", required: true, description: "The home they want to view", ordinal: 2 },
    { stableSlotId: "email", key: "email", type: "email", required: true, description: "Their email address", ordinal: 3 },
  ],
  steps: [
    { stableStepId: "brief", kind: "chat", instruction: "Ask which area they want to live in {{slot.area}} and their monthly budget {{slot.budget}}.", toolRef: null, ordinal: 0, metadata: {} },
    { stableStepId: "search", kind: "tool", instruction: "Search the homes.", toolRef: "search_catalog", ordinal: 1, metadata: {} },
    {
      stableStepId: "choose",
      kind: "chat",
      instruction: "Show the homes within their budget and ask which one they would like to view.",
      toolRef: null,
      ordinal: 2,
      metadata: { present: { from: "search", selection: "single", slot: "chosen_home" } },
    },
    { stableStepId: "contact", kind: "chat", instruction: "Confirm that they chose {{slot.chosen_home}}, naming it, and ask for their email address {{slot.email}} so an agent can arrange a viewing.", toolRef: null, ordinal: 3, metadata: {} },
  ],
  transitions: [edge("brief", "search", 0), edge("search", "choose", 1), edge("choose", "contact", 2), edge("contact", "handoff", 3)],
  terminals: [{ stableStepId: "handoff", kind: "handoff", instruction: "Tell them an agent will email them about viewing {{slot.chosen_home}}.", ordinal: 0 }],
  createdAt: new Date("2026-11-13T00:00:00.000Z"),
  updatedAt: new Date("2026-11-13T00:00:00.000Z"),
};
const routine = compileRoutineDefinition(definition);

const session = (cards: boolean, content: string): PreparedSession => ({
  agent: { id: "agent-1", workspaceId: "workspace-1", name: "Nico", chatModelOverride: null, replyCardsEnabled: cards },
  conversation: { id: CONVERSATION_ID, workspaceId: "workspace-1", sourceChannel: "website_embed" },
  userMessage: { id: "message-1", content },
  effectiveQuery: content,
  history: [],
  turnRoute: "retrieval",
  retrieval: { responseIdentity: null, responseSettings: { customInstruction: "You are the letting agency's assistant. Help visitors find a home to rent." } },
  resolvedContext: { snapshot: {}, fragments: [], renderFragments: [], staged: [] },
  directiveSteering: { rules: [], omissions: [], matches: [] },
  replyBlocks: { item_list: { layouts: ["carousel", "list"] } },
  turnTrace: { traceId: "trace-1", startedAt: new Date(0).toISOString(), stages: [] },
} as unknown as PreparedSession);

const modelGateway = new RoutineChatModelGateway(liveGateway, {
  workspaceContext: { workspaceId: "workspace-1" },
  usageContext: { accountId: null, workspaceId: "workspace-1", conversationId: CONVERSATION_ID, messageId: "message-1", surface: "assistant", operation: "answer", attemptKey: "routine_turn" },
});

const runtime = buildChatTurnRuntime({
  chatGateway: liveGateway,
  fallbackReplyComposer: { composeNoContext: async () => ({ text: "decline", declineReason: "content_gap" }) },
  skillOutcomeCapabilities: { supportsGroundedAnswer: () => false },
  skillResultReplyBlocks: new SkillResultReplyBlocks({ imageUrls: { forImage: (imageId) => ({ src: `https://api.example/images/${imageId}`, srcSet: "" }) } }),
});

/** The runner as the routine turn provider builds it, with the shipped prompts and the stub search. */
const runner = (cards: boolean, content: string) => new DefaultRoutineRunner(
  [routine],
  new RoutineNextStepSelector(modelGateway, {
    promptTemplate: loadPromptTemplate("chat/routine-next-step.md"),
    slotsPromptTemplate: loadPromptTemplate("chat/routine-next-step-slots.md"),
    filledSlotsPromptTemplate: loadPromptTemplate("chat/routine-next-step-filled-slots.md"),
    dateRulePromptTemplate: loadPromptTemplate("chat/routine-next-step-date-rule.md"),
    itemRulePromptTemplate: loadPromptTemplate("chat/routine-next-step-item-rule.md"),
    earlierSlotsPromptTemplate: loadPromptTemplate("chat/routine-next-step-earlier-slots.md"),
    slotFallbackPromptTemplate: loadPromptTemplate("chat/routine-next-step-slot-fallback.md"),
  }),
  new RoutineStepRenderer(modelGateway, {
    promptTemplate: loadPromptTemplate("chat/routine-step-reply.md"),
    terminalHandoffWithMessagePromptTemplate: loadPromptTemplate("chat/routine-step-terminal-handoff-with-message.md"),
    terminalHandoffDefaultPromptTemplate: loadPromptTemplate("chat/routine-step-terminal-handoff-default.md"),
    reaskPromptTemplate: loadPromptTemplate("chat/routine-step-reask.md"),
    reaskUnansweredPromptTemplate: loadPromptTemplate("chat/routine-step-reask-unanswered.md"),
    reaskUnreadablePromptTemplate: loadPromptTemplate("chat/routine-step-reask-unreadable.md"),
    reaskGapPromptTemplate: loadPromptTemplate("chat/routine-step-reask-gap.md"),
    reaskExhaustedGapPromptTemplate: loadPromptTemplate("chat/routine-step-reask-exhausted-gap.md"),
    reaskMissingSlotsPromptTemplate: loadPromptTemplate("chat/routine-step-reask-missing-slots.md"),
    reaskExhaustedPromptTemplate: loadPromptTemplate("chat/routine-step-reask-exhausted.md"),
    stuckHandoffPromptTemplate: loadPromptTemplate("chat/routine-step-stuck-handoff.md"),
    stepProgressPromptTemplate: loadPromptTemplate("chat/routine-step-progress.md"),
    contextEvidencePromptTemplate: loadPromptTemplate("chat/routine-step-context-evidence.md"),
    stepSourcesPromptTemplate: loadPromptTemplate("chat/routine-step-sources.md"),
    stepSourcesNonePromptTemplate: loadPromptTemplate("chat/routine-step-sources-none.md"),
    steeringPromptTemplate: loadPromptTemplate("chat/routine-step-steering.md"),
    groundedAnswerRenderer: createRoutineGroundedAnswerRenderer({
      session: session(cards, content),
      turnSkills: runtime.turnSkills,
      presentingSteps: runtime.presentingSteps,
      chatAnswerPresenter: runtime.chatAnswerPresenter,
    }),
  }),
  {
    dispatch: async () => {
      const result = toolCardStubTool.respond({ message: TOOL_CARD_LISTINGS_QUERY });
      return { status: "completed" as const, answer: result.content[0].text, outputs: { structuredContent: result.structuredContent } };
    },
  },
);

const EXECUTION_ID = "run-1";

const turn = (
  content: string,
  history: ConversationMessage[],
  events: Pick<TurnContext["inputEvent"], "itemSelection" | "shownItems"> = {},
): TurnContext => ({
  agent: { id: "agent-1", name: "Nico" },
  sessionId: CONVERSATION_ID,
  inputEvent: { id: `message-${history.length + 1}`, kind: "message", content, ...events },
  history,
  stagedContext: [],
  steering: [],
  // As the engine's routine claim sets them on every turn a routine runs.
  activeRoutineId: routine.id,
  activeRoutineExecutionId: EXECUTION_ID,
});

const BRIEF = "I'm looking for a flat in Mitte, up to 2,000 a month.";
const opening: RoutineState = { sessionId: CONVERSATION_ID, routineId: routine.id, executionId: EXECUTION_ID, path: [], variables: {}, status: "active" };

/**
 * The first turn: the brief is read, the search runs, and the presenting step replies. The reply's
 * message is stored the way the chat stores it, so the next turn reads its items as production does.
 */
const briefTurn = async (cards: boolean) => {
  const result = await runner(cards, BRIEF).resume({ turn: turn(BRIEF, []), state: opening, activationTurn: true });
  const presentation = presentRoutineRenderableAnswer(runtime.chatAnswerPresenter, result.response);
  const message = {
    id: "assistant-1", conversationId: CONVERSATION_ID, workspaceId: "workspace-1", role: "assistant",
    content: result.response.answer, createdAt: new Date(),
    metadata: {
      ...(presentation.replyBlocks ? { blocks: presentation.replyBlocks.stored } : {}),
      ...(presentation.listedItems ? { listedItems: [presentation.listedItems] } : {}),
    },
  } as unknown as MessageRecord;
  const history: ConversationMessage[] = [{ role: "user", content: BRIEF }, { role: "assistant", content: result.response.answer }];
  return { result, presentation, message, history, shownItems: latestRoutinePresentation([message]) };
};

const named = (answer: string, title: string | undefined): boolean => Boolean(title) && answer.toLowerCase().includes(title!.toLowerCase());

type Case = "tap" | "typed_title" | "typed_second" | "cards_off";

/**
 * One sample of one case. Every case aims at the second item the step showed: a tap on its card, its
 * exact title typed, "the second one" typed after the cards, or, with cards off, "the second one"
 * after the step listed the homes in text. The slot must then hold that stored item, link and all.
 */
const sample = async (which: Case) => {
  const first = await briefTurn(which !== "cards_off");
  const target = first.shownItems?.items[1];
  const block = first.presentation.replyBlocks?.stored[0];
  const message = which === "tap" ? target?.title ?? "" : which === "typed_title" ? `I'd like to see the ${target?.title ?? ""}.` : "the second one";
  const reading = which === "tap" && block && target
    ? readItemSelection(first.message, CONVERSATION_ID, { messageId: first.message.id, blockId: block.id, itemKey: target.key })
    : null;
  const itemSelection = reading?.ok ? routineItemSelectionOf(reading.item) : undefined;
  const next = first.result.nextState && target
    ? await runner(which !== "cards_off", message).resume({
      turn: turn(message, first.history, { ...(itemSelection ? { itemSelection } : {}), ...(first.shownItems ? { shownItems: first.shownItems } : {}) }),
      state: first.result.nextState,
    })
    : undefined;
  const slot = next?.nextState?.variables.chosen_home as { key?: string; title?: string; link?: string } | undefined;
  return {
    case: which,
    landedOn: first.result.nextState?.path.at(-1) ?? null,
    shown: first.shownItems ? { from: first.presentation.replyBlocks ? "cards" : "listed", titles: first.shownItems.items.map((item) => item.title) } : null,
    lead: first.result.response.answer,
    target: target?.title ?? null,
    slot: slot?.title ?? null,
    slotKeepsStoredItem: Boolean(slot && target && slot.key === target.key && slot.link === target.link),
    stepAfter: next?.nextState?.path.at(-1) ?? null,
    replyAfter: next?.response.answer ?? null,
    namesItem: named(next?.response.answer ?? "", target?.title),
  };
};

const passed = (result: Awaited<ReturnType<typeof sample>>): boolean =>
  result.landedOn === "choose" && result.slotKeepsStoredItem && result.stepAfter === "contact" && result.namesItem;

describe.skipIf(!apiKey)("live: a routine step shows a search's results, and the visitor's choice fills its slot", () => {
  it.each(["tap", "typed_title", "typed_second", "cards_off"] as const)(`%s fills the slot with the stored item, and the next step names it (${SAMPLES} samples)`, async (which) => {
    const results = [];
    for (let index = 0; index < SAMPLES; index += 1) {
      results.push(await sample(which));
    }
    console.log(JSON.stringify({ case: which, passed: results.filter(passed).length, of: SAMPLES, results }, null, 2));

    expect(results.every(passed)).toBe(true);
  }, 600_000);
});
