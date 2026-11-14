/**
 * LIVE verification (not part of CI) for #1763 slice 3: on WhatsApp, the model writes the words on
 * the cards' buttons. An Italian visitor asks a letting agency for flats; the agency's search (the
 * invented stub tool, `.example` records) returns listings with photos; the reply is written with
 * the WhatsApp capability, so the `present` head asks for `selectLabel` and `openLabel`. Everything
 * but the model is production code: the skill-result composer, the head, the cards and the labels
 * the presented block carries.
 *
 * Each of three samples must show cards, and both labels must be present, at most 20 UTF-16 units,
 * and Italian, as a typed judge on the same mini model reads them.
 *
 * Run with:
 *   cd backend && pnpm exec vitest run tests/live/whatsapp-button-labels.verify.test.ts --disableConsoleIntercept
 *
 * Reads OPENAI_API_KEY from the environment, else from the nearest `.env` above this file. Skips
 * itself when absent.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ChatGateway, ChatGatewayInput } from "../../src/modules/chat/contracts/chatGateway.js";
import { AGENT_SKILL_OUTCOME_KIND } from "../../src/modules/chat/composition.js";
import { buildChatTurnRuntime } from "../../src/modules/chat/services/chatTurnRuntime.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";
import { SkillResultReplyBlocks } from "../../src/modules/chat/services/replyBlocks/skillResultReplyBlocks.js";
import type { TurnOutcome } from "../../src/modules/chat/services/turnOutcome.js";
import { TOOL_CARD_LISTINGS_QUERY, TOOL_CARD_SKILL_NAME, toolCardStubTool } from "../fixtures/conversation-quality/toolCardCases.js";

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
const QUERY = "Avete appartamenti a Mitte sotto i 2.000 euro al mese?";

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

/** A WhatsApp turn for an agent with cards on: WhatsApp declares every layout and asks for button labels. */
const session = {
  agent: { id: "agent-1", workspaceId: "workspace-1", name: "Nico", chatModelOverride: null, replyCardsEnabled: true },
  conversation: { id: "conversation-1", workspaceId: "workspace-1", sourceChannel: "whatsapp" },
  userMessage: { id: "message-1", content: QUERY },
  effectiveQuery: QUERY,
  history: [],
  turnRoute: "retrieval",
  retrieval: { responseIdentity: null, responseSettings: { customInstruction: "You are a letting agency's assistant. Help visitors find a home to rent." } },
  resolvedContext: { snapshot: {}, fragments: [], renderFragments: [], staged: [] },
  directiveSteering: {
    rules: [{ action: "Search the listings and tell the visitor what matches.", source: "directive", lifespan: "response" }],
    omissions: [],
    matches: [],
  },
  replyBlocks: { item_list: { layouts: ["carousel", "grid", "list"], buttonLabels: true } },
} as unknown as PreparedSession;

const searchResult = toolCardStubTool.respond({ message: TOOL_CARD_LISTINGS_QUERY });
const outcome: TurnOutcome = {
  kind: AGENT_SKILL_OUTCOME_KIND,
  skillName: TOOL_CARD_SKILL_NAME,
  outcome: { status: "completed", answer: searchResult.content[0].text, outputs: { structuredContent: searchResult.structuredContent } },
  stagedContext: [],
  steering: [],
  trace: { traceId: "trace-1", startedAt: new Date(0).toISOString(), stages: [] },
};

const runtime = buildChatTurnRuntime({
  chatGateway: liveGateway,
  fallbackReplyComposer: { composeNoContext: async () => ({ text: "decline", declineReason: "content_gap" }) },
  skillOutcomeCapabilities: { supportsGroundedAnswer: () => false },
  skillResultReplyBlocks: new SkillResultReplyBlocks({ imageUrls: { forImage: (imageId) => ({ src: `https://api.example/images/${imageId}`, srcSet: "" }) } }),
});

/** A typed judge on the same model: whether each label is written in Italian. */
const judgeItalian = async (labels: { select: string; open: string }): Promise<{ select: boolean; open: boolean }> => {
  const raw = await complete({
    prompt: `Two button labels from a chat reply. For each, say whether it is written in Italian.\nselect: ${JSON.stringify(labels.select)}\nopen: ${JSON.stringify(labels.open)}`,
    responseFormat: {
      name: "italian_labels",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["select", "open"],
        properties: { select: { type: "boolean" }, open: { type: "boolean" } },
      },
    },
  });
  return JSON.parse(raw) as { select: boolean; open: boolean };
};

const sample = async () => {
  const presentation = await runtime.skillResultRenderer.render(outcome, { session, query: QUERY });
  const block = presentation.replyBlocks?.presented[0];
  const labels = block?.buttonLabels;
  const select = labels?.select ?? "";
  const open = labels?.open ?? "";
  const italian = labels?.select && labels.open ? await judgeItalian({ select, open }) : { select: false, open: false };
  return {
    lead: presentation.answer,
    cards: block?.items.length ?? 0,
    select,
    open,
    withinLimit: select.length > 0 && select.length <= 20 && open.length > 0 && open.length <= 20,
    italian,
  };
};

const passed = (result: Awaited<ReturnType<typeof sample>>): boolean =>
  result.cards > 0 && result.withinLimit && result.italian.select && result.italian.open;

describe.skipIf(!apiKey)("live: a WhatsApp reply's cards carry button labels the model writes in the visitor's language", () => {
  it(`an Italian visitor gets Italian labels of at most 20 characters (${SAMPLES} samples)`, async () => {
    const results = [];
    for (let index = 0; index < SAMPLES; index += 1) {
      results.push(await sample());
    }
    console.log(JSON.stringify({ passed: results.filter(passed).length, of: SAMPLES, results }, null, 2));

    expect(results.every(passed)).toBe(true);
  }, 300_000);
});
