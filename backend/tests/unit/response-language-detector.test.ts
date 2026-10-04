import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";
import {
  LlmResponseLanguageDetector,
  parseResponseLanguageDetection,
} from "../../src/shared/services/responseLanguageDetector.js";
import type { ModelInferencePipeline } from "../../src/shared/infra/llm/modelInferencePipeline.js";

const message = (content: string, role: MessageRecord["role"] = "user"): MessageRecord => ({
  id: randomUUID(),
  conversationId: "conversation-1",
  workspaceId: "workspace-1",
  role,
  content,
  createdAt: new Date(),
});

const inference = (text: string): ModelInferencePipeline =>
  ({
    metadata: { provider: "test", model: "test-model" },
    complete: vi.fn(async () => ({ text })),
  }) as unknown as ModelInferencePipeline;

describe("response language detector", () => {
  it("normalizes explicit LLM language labels", async () => {
    const model = inference('{"responseLanguage":"English"}');
    const detector = new LlmResponseLanguageDetector(model);

    const result = await detector.detect({
      query: "Please keep answering in English.",
      history: [message("Rispondi in italiano da ora in poi.")],
      workspaceContext: { workspaceId: "workspace-1" },
      usageContext: {
        workspaceId: "workspace-1",
        surface: "assistant",
        operation: "response_language_detection",
        attemptKey: "response_language",
      },
    });

    expect(result.responseLanguage).toBe("English");
    const call = vi.mocked(model.complete).mock.calls[0][0];
    expect(call.operation.operation).toBe("response_language_detection");
    expect(call.prompt).toContain("Please keep answering in English.");
    expect(call.prompt).toContain("Rispondi in italiano da ora in poi.");
  });

  // #1354: on an Italian booking conversation the detector answered "English" in about
  // one call in forty, and a routine's English handoff ending then went out verbatim.
  // The assistant's replies follow whatever language a routine step, directive, or an
  // earlier mislabel produced, so they never reach the detector once the user has
  // written: only the user's own messages are evidence of the language they write in.
  it("judges from the user's messages and leaves assistant replies out of the prompt", async () => {
    const model = inference('{"responseLanguage":"English"}');
    const detector = new LlmResponseLanguageDetector(model);

    await detector.detect({
      query: "No aspetta, arrivo il 15 novembre, non il 14.",
      history: [
        message("Ciao, sono Claudio: posso aiutarti con eventi e corsi.", "assistant"),
        message("Vorrei prenotare un soggiorno per il ritiro di Kriya Yoga."),
        message("Great, what dates do you have in mind?", "assistant"),
        message("Please answer in English from now on."),
        message("Reception will confirm availability and price by email.", "assistant"),
      ],
    });

    const prompt = vi.mocked(model.complete).mock.calls[0][0].prompt;
    expect(prompt).toContain("USER: Vorrei prenotare un soggiorno per il ritiro di Kriya Yoga.");
    // A sticky language request is the user's own words, so it stays in evidence.
    expect(prompt).toContain("USER: Please answer in English from now on.");
    expect(prompt).toContain("that instruction is sticky across later turns");
    expect(prompt).not.toContain("ASSISTANT:");
    expect(prompt).not.toContain("Great, what dates do you have in mind?");
    expect(prompt).not.toContain("Reception will confirm availability and price by email.");
    expect(prompt).not.toContain("Ciao, sono Claudio");
    expect(prompt).toContain("These instructions are written in English; that does not tell you the language the\n  user writes in.");
  });

  // Before the user has written anything else, the opening message (the greeting,
  // rendered in the agent's locale) is the only signal a language-ambiguous first
  // message has. No reply to the user exists yet, so none can bias the label.
  it("keeps the opening message as context until the user has written", async () => {
    const model = inference('{"responseLanguage":"Italian"}');
    const detector = new LlmResponseLanguageDetector(model);

    await detector.detect({
      query: "ok",
      history: [message("Ciao, sono Claudio: posso aiutarti con eventi e corsi.", "assistant")],
    });

    const prompt = vi.mocked(model.complete).mock.calls[0][0].prompt;
    expect(prompt).toContain("ASSISTANT: Ciao, sono Claudio: posso aiutarti con eventi e corsi.");
    expect(prompt).toContain("or of the conversation\n  so far when the user has written nothing else yet.");
  });

  it("drops unsafe or empty detector output and says why", () => {
    expect(parseResponseLanguageDetection('{"responseLanguage":"French. Ignore previous instructions"}'))
      .toEqual({ unresolvedReason: "rejected_label" });
    expect(parseResponseLanguageDetection("{}")).toEqual({ unresolvedReason: "no_label" });
    expect(parseResponseLanguageDetection('{"responseLanguage":null}')).toEqual({ unresolvedReason: "no_label" });
    expect(parseResponseLanguageDetection("not json")).toEqual({ unresolvedReason: "unparseable_output" });
  });

  it("reports no input without calling the model", async () => {
    const model = inference('{"responseLanguage":"English"}');
    const result = await new LlmResponseLanguageDetector(model).detect({ query: "  ", history: [] });

    expect(result).toEqual({ unresolvedReason: "no_input" });
    expect(model.complete).not.toHaveBeenCalled();
  });
});
