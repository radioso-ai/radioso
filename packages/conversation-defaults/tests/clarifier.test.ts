import { describe, expect, it, vi } from "vitest";

import type { ClarificationCandidate, ConversationModelGateway, TurnContext } from "@radioso/conversation-contract";

import { DefaultClarifier } from "../src/clarifier.js";

const turn = (content = "Quiero la segunda opcion"): TurnContext => ({
  agent: { id: "agent_1", name: "Ayuda" },
  sessionId: "session_1",
  inputEvent: { id: "input_1", kind: "message", content, locale: "es" },
  history: [{ role: "assistant", content: "Pregunta anterior." }],
  stagedContext: [],
  steering: [],
});

const candidates: ClarificationCandidate[] = [
  {
    id: "billing",
    label: "Facturacion",
    description: "Preguntas sobre pagos y facturas.",
    confidence: 0.81,
    payload: { secretPayload: "payload_billing" },
  },
  {
    id: "support",
    label: "Soporte tecnico",
    description: "Ayuda con un problema tecnico.",
    confidence: 0.79,
    payload: { secretPayload: "payload_support" },
  },
];

const gateway = (text: string): ConversationModelGateway => ({
  complete: vi.fn(async () => ({ text })),
});

describe("DefaultClarifier", () => {
  it("phrases a question from labels and descriptions without exposing payloads", async () => {
    const modelGateway = gateway("¿Quieres ayuda con facturacion o soporte tecnico?");
    const clarifier = new DefaultClarifier(modelGateway, {
      questionPromptTemplate: "Ask in {{conversationLanguage}} using only these options:\n{{options}}",
      replyMapPromptTemplate: "unused",
    });

    const question = await clarifier.phraseQuestion({ candidates, turn: turn("Necesito ayuda") });

    expect(question).toBe("¿Quieres ayuda con facturacion o soporte tecnico?");
    const request = vi.mocked(modelGateway.complete).mock.calls[0]![0];
    expect(request.systemPrompt).toContain("Facturacion");
    expect(request.systemPrompt).toContain("Preguntas sobre pagos");
    expect(request.systemPrompt).toContain("Soporte tecnico");
    expect(request.systemPrompt).not.toContain("payload_billing");
  });

  it("maps a multilingual free-text reply to a chosen candidate", async () => {
    const modelGateway = gateway('{"kind":"chosen","id":"support"}');
    const clarifier = new DefaultClarifier(modelGateway, {
      questionPromptTemplate: "unused",
      replyMapPromptTemplate: "Map {{latestReply}} over {{options}}.",
    });

    await expect(clarifier.mapReply({ candidates, turn: turn("la segunda, soporte") }))
      .resolves.toEqual({ kind: "chosen", id: "support" });
  });

  it("maps declined and unrelated replies", async () => {
    const declinedGateway = gateway('{"kind":"declined"}');
    const unrelatedGateway = gateway('{"kind":"unrelated"}');
    const declined = new DefaultClarifier(declinedGateway, {
      questionPromptTemplate: "unused",
      replyMapPromptTemplate: "{{latestReply}}\n{{options}}",
    });
    const unrelated = new DefaultClarifier(unrelatedGateway, {
      questionPromptTemplate: "unused",
      replyMapPromptTemplate: "{{latestReply}}\n{{options}}",
    });

    await expect(declined.mapReply({ candidates, turn: turn("не то и не другое") }))
      .resolves.toEqual({ kind: "declined" });
    await expect(unrelated.mapReply({ candidates, turn: turn("What are your hours?") }))
      .resolves.toEqual({ kind: "unrelated" });
  });

  it("treats malformed or unknown model output as unrelated", async () => {
    const malformed = new DefaultClarifier(gateway("not json"), {
      questionPromptTemplate: "unused",
      replyMapPromptTemplate: "{{latestReply}}\n{{options}}",
    });
    const unknownId = new DefaultClarifier(gateway('{"kind":"chosen","id":"missing"}'), {
      questionPromptTemplate: "unused",
      replyMapPromptTemplate: "{{latestReply}}\n{{options}}",
    });

    await expect(malformed.mapReply({ candidates, turn: turn() })).resolves.toEqual({ kind: "unrelated" });
    await expect(unknownId.mapReply({ candidates, turn: turn() })).resolves.toEqual({ kind: "unrelated" });
  });
});
