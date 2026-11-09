import { describe, expect, it, vi } from "vitest";

import type {
  ConversationModelGateway,
  ConversationModelRequest,
  RoutineStep,
  RoutineStepReplyInput,
  StagedContext,
  TurnContext,
} from "@radioso/conversation-contract";
import { RoutineStepRenderer } from "../src/index.js";

/**
 * A step reply is told which sources it has for the facts it gives (#1717). With no page and no
 * retrieved excerpts, a dates step told to state the edition's dates "from the sources" said
 * "The course dates I hold for you are 17 November to 27 November": the visitor's own window,
 * presented as the course's.
 */

const datesStep: RoutineStep = {
  id: "dates",
  kind: "chat",
  action: "Tell them the start and end dates of the edition from the sources and ask them to confirm them.",
};

const turn: TurnContext = {
  agent: { id: "a", name: "Assistant" },
  sessionId: "s1",
  inputEvent: { id: "i1", kind: "message", content: "Il corso residenziale d'autunno" },
  history: [
    { role: "user", content: "Vorrei prenotare un corso, sarei libera tra il 17 e il 27 novembre." },
    { role: "assistant", content: "Volentieri! Quale corso vuoi prenotare?" },
  ],
  stagedContext: [],
  steering: [],
};

const pageEvidence = "<page_excerpt>Autumn residential course: 22 to 27 November 2026.</page_excerpt>";

const retrieval = (contexts: unknown[]): StagedContext => ({
  kind: "skill_result",
  source: "retrieval.context",
  data: { contexts },
});

const autumnExcerpt = { documentId: "doc_1", title: "Autumn course", content: "Runs 22 to 27 November 2026." };

const SOURCES_ONLY = "SOURCES:{{step_sources}}";

const requestFor = async (
  input: Partial<RoutineStepReplyInput>,
  promptTemplate?: string,
): Promise<ConversationModelRequest> => {
  const gateway: ConversationModelGateway = { complete: vi.fn(async () => ({ text: "ok" })) };
  await new RoutineStepRenderer(gateway, promptTemplate ? { promptTemplate } : {}).render({
    step: datesStep,
    steering: [],
    turn,
    ...input,
  });
  return vi.mocked(gateway.complete).mock.calls[0][0];
};

const sourcesFor = async (input: Partial<RoutineStepReplyInput>): Promise<string> =>
  (await requestFor(input, SOURCES_ONLY)).systemPrompt ?? "";

describe("RoutineStepRenderer tells a step reply which sources it has (#1717)", () => {
  it("says a step with no page excerpt and no retrieved excerpts has no sources", async () => {
    expect(await sourcesFor({})).toBe(
      "SOURCES:none: no retrieved document excerpts and no evidence from the visitor's context were provided",
    );
  });

  it("names the visitor's context evidence when the step reads the page", async () => {
    expect(await sourcesFor({ contextEvidence: [pageEvidence] })).toBe(
      "SOURCES:the evidence from the visitor's context",
    );
  });

  it("names the retrieved excerpts when a retrieval step staged some", async () => {
    expect(await sourcesFor({ turn: { ...turn, stagedContext: [retrieval([autumnExcerpt])] } })).toBe(
      "SOURCES:the retrieved document excerpts",
    );
  });

  it("names both when the step has retrieved excerpts and the page", async () => {
    expect(
      await sourcesFor({ turn: { ...turn, stagedContext: [retrieval([autumnExcerpt])] }, contextEvidence: [pageEvidence] }),
    ).toBe("SOURCES:the retrieved document excerpts and the evidence from the visitor's context");
  });

  it("counts a retrieval that found nothing, or nothing with text, as no source", async () => {
    expect(await sourcesFor({ turn: { ...turn, stagedContext: [retrieval([])] } })).toMatch(/^SOURCES:none: /u);
    expect(
      await sourcesFor({ turn: { ...turn, stagedContext: [retrieval([{ title: "Autumn course", content: "  " }, "text"])] } }),
    ).toMatch(/^SOURCES:none: /u);
  });

  it("ignores staged context that is not a retrieval result", async () => {
    const staged: StagedContext = {
      kind: "context_variable",
      source: "context.page_context",
      data: { content: "Autumn residential course: 22 to 27 November 2026." },
    };
    expect(await sourcesFor({ turn: { ...turn, stagedContext: [staged] } })).toMatch(/^SOURCES:none: /u);
  });

  it("gives a re-asked step the same sources", async () => {
    expect(
      await sourcesFor({
        contextEvidence: [pageEvidence],
        reask: { missingSlots: [{ id: "slot_departure", key: "departure", type: "date", required: true }] },
      }),
    ).toBe("SOURCES:the evidence from the visitor's context");
  });

  it("keeps the visitor's words and the page text out of the system prompt", async () => {
    const request = await requestFor({ contextEvidence: [pageEvidence] });

    expect(request.systemPrompt).not.toContain("17 e il 27 novembre");
    expect(request.systemPrompt).not.toContain("22 to 27 November");
    expect(request.messages.filter((message) => message.content.includes(pageEvidence))).toHaveLength(1);
  });

  it("states, in the shipped prompt after the step instruction, that a fact the step lacks a source for is asked, not taken from the user", async () => {
    // The template wraps its lines; read it as running text.
    const systemPrompt = ((await requestFor({})).systemPrompt ?? "").replace(/\s+/gu, " ");

    const sourcesAt = systemPrompt.indexOf("Sources for this message: none: ");
    expect(sourcesAt).toBeGreaterThan(systemPrompt.indexOf(datesStep.action ?? ""));
    expect(sourcesAt).toBeLessThan(systemPrompt.indexOf("This message is part of an unfinished flow"));
    expect(systemPrompt).toContain(
      "take it only from the sources listed here, never from the user's messages or from your own knowledge.",
    );
    expect(systemPrompt).toContain("never as a fact about what is offered or as a value you hold for them.");
    expect(systemPrompt).toContain("If no listed source gives the fact, do not state or guess it");
  });

  it("tells a terminal step's reply its sources too", async () => {
    const terminal: RoutineStep = { id: "done", kind: "terminal", action: "Tell them the edition dates from the sources." };

    expect(await sourcesFor({ step: terminal })).toMatch(/^SOURCES:none: /u);
  });
});
