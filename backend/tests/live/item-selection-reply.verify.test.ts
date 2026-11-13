/**
 * LIVE verification (not part of CI) for #1763 US3: after a visitor picks a card, the real model
 * answers about the picked item. The grounded answer runs through the production prompt builder,
 * answer composer and the shipped `chat/selected-item.md` prompt on the real mini model.
 *
 * The two cards share a title, as two photos captioned the same way on different pages do, so the
 * visitor's message ("Sunset cruise") cannot say which one they mean: only the selection fact,
 * with the picked card's document, can. A typed judge reads the answer for the picked boat and
 * the other boat. Three samples.
 *
 * Run with:
 *   cd backend && OPENAI_API_KEY=… pnpm exec vitest run tests/live/item-selection-reply.verify.test.ts
 *
 * Reads OPENAI_API_KEY from the environment, else from the repo-root .env. Skips itself when absent.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ChatGateway, ChatGatewayInput } from "../../src/modules/chat/contracts/chatGateway.js";
import { AssistantSuggestionExpansionService } from "../../src/modules/chat/services/assistantSuggestionExpansionService.js";
import { ChatAnswerPresenter } from "../../src/modules/chat/services/chatAnswerPresenter.js";
import { ChatAnswerSupport } from "../../src/modules/chat/services/chatAnswerSupport.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";
import type { FallbackReplyComposer } from "../../src/modules/chat/services/fallbackReplyComposer.js";
import type { SelectedItem } from "../../src/modules/chat/services/replyBlocks/itemSelection.js";
import { RetrievalAnswerComposer } from "../../src/modules/chat/services/retrievalTurnSkill.js";
import { PromptBuilder } from "../../src/modules/retrieval/services/promptBuilder.js";
import { createDirectiveAdherenceSideChannel } from "../../src/shared/domain/directiveAdherence.js";

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

/** The production gateway's call on the chat completions API: the system prompt, the prompt, and the strict schema. */
const liveGateway: ChatGateway = {
  async answer(input: ChatGatewayInput) {
    const format = input.generation?.responseFormat as { name: string; strict: boolean; schema: unknown } | undefined;
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
  },
  async *streamAnswer(input: ChatGatewayInput) {
    yield await liveGateway.answer(input);
  },
};

const pages = [
  {
    documentId: "doc-osprey",
    chunkId: "chunk-osprey",
    title: "The Osprey: evening sailing from Pier 3",
    content: "The Osprey is a wooden ketch that leaves Pier 3 at 18:30 for a two-hour sunset cruise along the cliffs. Twelve guests at most; drinks are included.",
    metadata: { sourceUrl: "https://harbour-tours.example/osprey" },
  },
  {
    documentId: "doc-kestrel",
    chunkId: "chunk-kestrel",
    title: "The Kestrel: catamaran trips from Pier 9",
    content: "The Kestrel is a catamaran that leaves Pier 9 at 19:00 for a ninety-minute sunset cruise to the seal colony. Children under six sail free; bring a jacket.",
    metadata: { sourceUrl: "https://harbour-tours.example/kestrel" },
  },
];

const picked: SelectedItem = {
  messageId: "7c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5",
  blockId: "b1",
  key: "image-kestrel-sunset",
  title: "Sunset cruise",
  link: "https://harbour-tours.example/kestrel",
  document: { id: "doc-kestrel", title: "The Kestrel: catamaran trips from Pier 9" },
};

const history = [
  { id: "m1", role: "user", content: "Do you have evening boat trips?" },
  { id: "m2", role: "assistant", content: "Two boats sail at sunset. Pick one to hear more." },
].map((message) => ({ ...message, conversationId: "conversation-1", workspaceId: "workspace-1", createdAt: new Date() })) as never[];

const session = (): PreparedSession => {
  const built = new PromptBuilder().build({
    query: picked.title,
    history,
    contexts: pages.map((page, index) => ({ ...page, promptPosition: index, estimatedTokenCost: 60 })) as never,
    timeZone: "UTC",
    settings: {},
  });
  return {
    agent: { id: "agent-1", workspaceId: "workspace-1", chatModelOverride: null, replyCardsEnabled: false } as never,
    conversation: { id: "conversation-1", workspaceId: "workspace-1", sourceChannel: "website_embed" } as never,
    history,
    userMessage: { id: "message-3", content: picked.title } as never,
    itemSelection: picked,
    effectiveQuery: picked.title,
    turnRoute: "retrieval",
    pageContext: null,
    resolvedContext: { fragments: [], renderFragments: [], staged: [], snapshot: {} },
    directiveSteering: { rules: [], matches: [], omissions: [] },
    retrieval: {
      systemPrompt: built.systemPrompt,
      prompt: built.prompt,
      responseIdentity: null,
      responseSettings: { suggestedQuestionsEnabled: false, suggestedQuestionsCount: 0 },
      diagnostics: {},
      contexts: pages,
    },
  } as unknown as PreparedSession;
};

const fallback: FallbackReplyComposer = {
  async composeNoContext() {
    return { text: "decline", declineReason: "content_gap" };
  },
};

const composer = () => new RetrievalAnswerComposer(
  new ChatAnswerSupport(),
  liveGateway,
  new ChatAnswerPresenter(new AssistantSuggestionExpansionService(), undefined, { supportsGroundedAnswer: () => true }),
  fallback,
  null,
  { forSteeringRules: (rules) => createDirectiveAdherenceSideChannel(rules) },
);

/** The typed judge: whether the answer is about the picked boat, and whether it is about the other one. */
const judge = (answer: string) => ({
  aboutPicked: /kestrel|pier 9|catamaran|seal/i.test(answer),
  aboutOther: /osprey|pier 3|ketch/i.test(answer),
});

describe.skipIf(!apiKey)("live: the reply after a pick is about the picked item", () => {
  it(`answers about the picked card, not the other with the same title (${SAMPLES} samples)`, async () => {
    const verdicts: Array<{ answer: string; aboutPicked: boolean; aboutOther: boolean }> = [];
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      const { answer } = await composer().composeAnswer(session(), picked.title, "en", undefined);
      verdicts.push({ answer, ...judge(answer) });
    }
    console.log(JSON.stringify(verdicts, null, 2));

    expect(verdicts.every(({ aboutPicked, aboutOther }) => aboutPicked && !aboutOther)).toBe(true);
  }, 180_000);
});
