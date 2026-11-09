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
 * A step reply is told which quoted sources it has besides its instruction (#1717). With no
 * page and no retrieved excerpts, a dates step told to state the edition's dates "from the
 * sources" said "The course dates I hold for you are 17 November to 27 November": the
 * visitor's own window, presented as the course's.
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

// What the reply is told about its sources, read off sources templates that print only that.
const PRESENCE_TEMPLATE = "SOURCES[retrieved={{retrieved_excerpts}},evidence={{context_evidence}}]";
const NONE_TEMPLATE = "SOURCES[none]";

const requestFor = async (
  input: Partial<RoutineStepReplyInput>,
  options: { promptTemplate?: string; stepProgressPromptTemplate?: string } = {},
): Promise<ConversationModelRequest> => {
  const gateway: ConversationModelGateway = { complete: vi.fn(async () => ({ text: "ok" })) };
  await new RoutineStepRenderer(gateway, {
    ...options,
    stepSourcesPromptTemplate: PRESENCE_TEMPLATE,
    stepSourcesNonePromptTemplate: NONE_TEMPLATE,
  }).render({
    step: datesStep,
    steering: [],
    turn,
    ...input,
  });
  return vi.mocked(gateway.complete).mock.calls[0][0];
};

const reportedSources = async (input: Partial<RoutineStepReplyInput>): Promise<string> =>
  (await requestFor(input, { promptTemplate: "{{step_sources}}" })).systemPrompt ?? "";

describe("RoutineStepRenderer tells a step reply which quoted sources it has (#1717)", () => {
  it("tells a step with no page excerpt and no retrieved excerpts that it has no source", async () => {
    expect(await reportedSources({})).toBe("SOURCES[none]");
  });

  it("reports the visitor's context evidence when the step reads the page", async () => {
    expect(await reportedSources({ contextEvidence: [pageEvidence] })).toBe("SOURCES[retrieved=none,evidence=provided]");
  });

  it("reports the retrieved excerpts when a retrieval step staged some", async () => {
    expect(await reportedSources({ turn: { ...turn, stagedContext: [retrieval([autumnExcerpt])] } })).toBe(
      "SOURCES[retrieved=provided,evidence=none]",
    );
  });

  it("reports both when the step has retrieved excerpts and the page", async () => {
    expect(
      await reportedSources({ turn: { ...turn, stagedContext: [retrieval([autumnExcerpt])] }, contextEvidence: [pageEvidence] }),
    ).toBe("SOURCES[retrieved=provided,evidence=provided]");
  });

  it("reports no retrieved excerpts for a retrieval that found nothing, or nothing with text", async () => {
    expect(await reportedSources({ turn: { ...turn, stagedContext: [retrieval([])] } })).toBe("SOURCES[none]");
    expect(
      await reportedSources({ turn: { ...turn, stagedContext: [retrieval([{ title: "Autumn course", content: "  " }, "text"])] } }),
    ).toBe("SOURCES[none]");
  });

  it("ignores staged context that is not a retrieval result", async () => {
    const staged: StagedContext = {
      kind: "context_variable",
      source: "context.page_context",
      data: { content: "Autumn residential course: 22 to 27 November 2026." },
    };
    expect(await reportedSources({ turn: { ...turn, stagedContext: [staged] } })).toBe("SOURCES[none]");
  });

  it("reports the same sources on a re-ask", async () => {
    expect(
      await reportedSources({
        contextEvidence: [pageEvidence],
        reask: { missingSlots: [{ id: "slot_departure", key: "departure", type: "date", required: true }] },
      }),
    ).toBe("SOURCES[retrieved=none,evidence=provided]");
  });

  it("leaves a context block rendered into the instruction in the instruction, where the reply may state it", async () => {
    const block = '<context_variable name="course_dates">22 to 27 November 2026</context_variable>';
    const step: RoutineStep = { ...datesStep, action: `Tell them the edition dates, ${block}, and ask them to confirm.` };

    const request = await requestFor({ step });

    // The block is no quoted source of its own: the reply still hears it has none besides the
    // instruction, and reads the block where the instruction carries it, once.
    const systemPrompt = request.systemPrompt ?? "";
    expect(systemPrompt).toContain(`- ${step.action}`);
    expect(systemPrompt.match(/22 to 27 November 2026/gu)).toHaveLength(1);
    expect(systemPrompt.indexOf(block)).toBeLessThan(systemPrompt.indexOf("SOURCES[none]"));
    expect(JSON.stringify(request.messages)).not.toContain("22 to 27 November 2026");
  });

  it("keeps the visitor's words and the page text out of the system prompt", async () => {
    const request = await requestFor({ contextEvidence: [pageEvidence] });

    expect(request.systemPrompt).not.toContain("17 e il 27 novembre");
    expect(request.systemPrompt).not.toContain("22 to 27 November");
    expect(request.messages.filter((message) => message.content.includes(pageEvidence))).toHaveLength(1);
  });

  it("reports the sources once in the shipped prompt, after the step instruction and before the closing rules", async () => {
    // Placed with the facts paragraph near the top, the same rule left the visitor's window
    // stated as the edition's dates in 5 of 5 runs; after the step instruction, in 0 of 5.
    const systemPrompt = (await requestFor({}, { stepProgressPromptTemplate: "PROGRESS-RULE" })).systemPrompt ?? "";

    const sourcesAt = systemPrompt.indexOf("SOURCES[none]");
    expect(systemPrompt.match(/SOURCES\[/gu)).toHaveLength(1);
    expect(sourcesAt).toBeGreaterThan(systemPrompt.indexOf(datesStep.action ?? ""));
    expect(sourcesAt).toBeLessThan(systemPrompt.indexOf("PROGRESS-RULE"));
  });

  it("reports a terminal step's sources too", async () => {
    const terminal: RoutineStep = { id: "done", kind: "terminal", action: "Tell them the edition dates from the sources." };

    expect(await reportedSources({ step: terminal })).toBe("SOURCES[none]");
  });
});
