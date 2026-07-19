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
  it("returns the localized lead-in followed by every option, without exposing payloads", async () => {
    const modelGateway = gateway("¿Cuál de estas describe lo que buscas?");
    const clarifier = new DefaultClarifier(modelGateway, {
      questionPromptTemplate: "Escribe una invitación breve en {{conversationLanguage}}.",
      replyMapPromptTemplate: "unused",
    });

    const question = await clarifier.phraseQuestion({ candidates, turn: turn("Necesito ayuda") });

    expect(question).toBe([
      "¿Cuál de estas describe lo que buscas?",
      "",
      "1. Facturacion — Preguntas sobre pagos y facturas.",
      "2. Soporte tecnico — Ayuda con un problema tecnico.",
    ].join("\n"));
    // The model authors only the lead-in; it is never handed the option labels, so it
    // cannot echo one back as the whole answer.
    const request = vi.mocked(modelGateway.complete).mock.calls[0]![0];
    expect(request.systemPrompt).toContain("es");
    expect(request.systemPrompt).not.toContain("Facturacion");
    expect(request.systemPrompt).not.toContain("payload_billing");
    expect(question).not.toContain("payload_billing");
  });

  it("still lists every option when the model collapses to a single bare label", async () => {
    // Regression for the production failure: the question generator returned just one
    // sense label ("What spirituality means and how to approach it") as the entire
    // reply, hiding the other options. The options are now assembled in code, so even
    // a degenerate model output cannot drop them.
    const modelGateway = gateway("Facturacion");
    const clarifier = new DefaultClarifier(modelGateway, {
      questionPromptTemplate: "Lead-in in {{conversationLanguage}}",
      replyMapPromptTemplate: "unused",
    });

    const question = await clarifier.phraseQuestion({ candidates, turn: turn("Necesito ayuda") });

    expect(question).toContain("1. Facturacion — Preguntas sobre pagos y facturas.");
    expect(question).toContain("2. Soporte tecnico — Ayuda con un problema tecnico.");
  });

  it("falls back to the bare options list when the model returns nothing", async () => {
    const modelGateway = gateway("   ");
    const clarifier = new DefaultClarifier(modelGateway, {
      questionPromptTemplate: "Lead-in in {{conversationLanguage}}",
      replyMapPromptTemplate: "unused",
    });

    const question = await clarifier.phraseQuestion({ candidates, turn: turn("Necesito ayuda") });

    expect(question).toBe([
      "1. Facturacion — Preguntas sobre pagos y facturas.",
      "2. Soporte tecnico — Ayuda con un problema tecnico.",
    ].join("\n"));
  });

  it("never renders an option whose label is empty or collapses to its candidate id", async () => {
    const modelGateway = gateway("¿Cuál de estas describe lo que buscas?");
    const clarifier = new DefaultClarifier(modelGateway, {
      questionPromptTemplate: "Lead-in in {{conversationLanguage}}",
      replyMapPromptTemplate: "unused",
    });

    const question = await clarifier.phraseQuestion({
      candidates: [
        ...candidates,
        { id: "doc-empty", label: "   ", confidence: 0.4, payload: {} },
        { id: "doc-42", label: "doc-42", confidence: 0.4, payload: {} },
      ],
      turn: turn("Necesito ayuda"),
    });

    expect(question).toContain("1. Facturacion — Preguntas sobre pagos y facturas.");
    expect(question).toContain("2. Soporte tecnico — Ayuda con un problema tecnico.");
    expect(question).not.toContain("doc-empty");
    expect(question).not.toContain("doc-42");
    expect(question).not.toContain("3.");
  });

  it("folds turn steering into the question prompt as guidance", async () => {
    const modelGateway = gateway("¿Facturacion o soporte?");
    const clarifier = new DefaultClarifier(modelGateway, {
      questionPromptTemplate: "Lead-in in {{conversationLanguage}}",
      replyMapPromptTemplate: "unused",
    });

    await clarifier.phraseQuestion({
      candidates,
      turn: {
        ...turn("Necesito ayuda"),
        steering: [
          { action: "Use a warm, friendly tone.", source: "directive", lifespan: "response" },
          { action: "Keep it to one sentence.", source: "directive", lifespan: "response", condition: "the user seems rushed" },
        ],
      },
    });

    const systemPrompt = vi.mocked(modelGateway.complete).mock.calls[0]![0].systemPrompt
    expect(systemPrompt).toContain("Use a warm, friendly tone.")
    expect(systemPrompt).toContain("Keep it to one sentence.")
    expect(systemPrompt).toContain("the user seems rushed")
  });

  it("leaves the question prompt unchanged when there is no steering", async () => {
    const modelGateway = gateway("¿Facturacion o soporte?");
    const clarifier = new DefaultClarifier(modelGateway, {
      questionPromptTemplate: "Lead-in in {{conversationLanguage}}",
      replyMapPromptTemplate: "unused",
    });

    await clarifier.phraseQuestion({ candidates, turn: turn("Necesito ayuda") });

    const systemPrompt = vi.mocked(modelGateway.complete).mock.calls[0]![0].systemPrompt
    expect(systemPrompt).toBe("Lead-in in es")
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

  it("maps exact option ids and labels without asking the model", async () => {
    const modelGateway = gateway('{"kind":"declined"}');
    const clarifier = new DefaultClarifier(modelGateway, {
      questionPromptTemplate: "unused",
      replyMapPromptTemplate: "unused",
    });

    await expect(clarifier.mapReply({ candidates, turn: turn(" Soporte   tecnico ") }))
      .resolves.toEqual({ kind: "chosen", id: "support" });
    await expect(clarifier.mapReply({ candidates, turn: turn("BILLING") }))
      .resolves.toEqual({ kind: "chosen", id: "billing" });
    expect(modelGateway.complete).not.toHaveBeenCalled();
  });

  it("uses the stricter offer reply prompt for non-exact offer replies", async () => {
    const modelGateway = gateway('{"kind":"unrelated"}');
    const clarifier = new DefaultClarifier(modelGateway, {
      questionPromptTemplate: "unused",
      replyMapPromptTemplate: "ask prompt {{latestReply}}",
      offerReplyMapPromptTemplate: "offer prompt {{latestReply}} {{options}}",
    });

    await expect(clarifier.mapReply({
      candidates,
      turn: turn("What does Soporte tecnico cost?"),
      mode: "offer",
    })).resolves.toEqual({ kind: "unrelated" });

    expect(modelGateway.complete).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: expect.stringContaining("offer prompt What does Soporte tecnico cost?"),
    }));
    expect(vi.mocked(modelGateway.complete).mock.calls[0]?.[0].systemPrompt).not.toContain("ask prompt");
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
