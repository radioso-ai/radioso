import { describe, expect, it, vi } from "vitest";

import { ChatActionSuggestionRegistry } from "../../src/modules/chat/services/actionSuggestions/chatActionSuggestionRegistry.js";
import { ChatActionSuggestionService } from "../../src/modules/chat/services/actionSuggestions/chatActionSuggestionService.js";
import type {
  ChatActionSuggestionContext,
  ChatActionSuggestionProvider,
} from "../../src/modules/chat/services/actionSuggestions/chatActionSuggestionProvider.js";
import type { ChatSuggestion } from "../../src/modules/chat/types/chatResponses.js";

const baseContext: ChatActionSuggestionContext = {
  workspaceId: "ws-1",
  conversationId: "conv-1",
  query: "Why?",
  answer: "I don't have that information.",
  skillName: "retrieval.answer",
  skillOutcome: "no_context",
  skillStatus: "completed",
  answerOutcome: "no_context_refusal",
  history: [],
};

const provider = (
  name: string,
  result: ChatSuggestion | null,
): ChatActionSuggestionProvider => ({
  name,
  evaluate: vi.fn(async () => result),
});

const throwingProvider = (name: string, error: Error): ChatActionSuggestionProvider => ({
  name,
  evaluate: vi.fn(async () => {
    throw error;
  }),
});

const buildSuggestion = (kind: string, text: string): ChatSuggestion => ({
  text,
  kind,
  action: { kind: "start_intent", intent: { skillName: `skill_${kind}` } },
});

describe("ChatActionSuggestionService", () => {
  it("returns an empty array when no providers are registered", async () => {
    const service = new ChatActionSuggestionService(new ChatActionSuggestionRegistry());

    await expect(service.evaluate(baseContext)).resolves.toEqual([]);
  });

  it("returns the first non-null provider result, capped at one chip per turn", async () => {
    const registry = new ChatActionSuggestionRegistry([
      provider("a", buildSuggestion("a_kind", "A")),
      provider("b", buildSuggestion("b_kind", "B")),
    ]);
    const service = new ChatActionSuggestionService(registry);

    const result = await service.evaluate(baseContext);

    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe("a_kind");
  });

  it("dedupes by kind when multiple providers return the same kind", async () => {
    const registry = new ChatActionSuggestionRegistry([
      provider("a", null),
      provider("b", buildSuggestion("contact_human", "Talk")),
      provider("c", buildSuggestion("contact_human", "Talk again")),
    ]);
    const service = new ChatActionSuggestionService(registry);

    const result = await service.evaluate(baseContext);

    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe("Talk");
  });

  it("isolates provider errors so one failure does not block other providers", async () => {
    const onError = vi.fn();
    const registry = new ChatActionSuggestionRegistry([
      throwingProvider("broken", new Error("boom")),
      provider("good", buildSuggestion("contact_human", "Contact us")),
    ]);
    const service = new ChatActionSuggestionService(registry, { onError });

    const result = await service.evaluate(baseContext);

    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe("contact_human");
    expect(onError).toHaveBeenCalledWith("broken", expect.any(Error));
  });

  it("ignores null results from providers", async () => {
    const registry = new ChatActionSuggestionRegistry([
      provider("a", null),
      provider("b", null),
    ]);
    const service = new ChatActionSuggestionService(registry);

    await expect(service.evaluate(baseContext)).resolves.toEqual([]);
  });
});
