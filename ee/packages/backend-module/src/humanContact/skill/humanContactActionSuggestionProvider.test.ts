import { describe, expect, it, vi } from "vitest";

import { HumanContactActionSuggestionProvider } from "./humanContactActionSuggestionProvider.js";
import { HUMAN_CONTACT_SKILL_NAME } from "../humanContactTypes.js";
import type { ChatActionSuggestionContext } from "../../radiosoModuleTypes.js";

const baseContext: ChatActionSuggestionContext = {
  workspaceId: "ws-1",
  conversationId: "conv-1",
  query: "Why does X happen?",
  answer: "I don't have that information.",
  skillName: "retrieval.answer",
  skillOutcome: "no_context",
  skillStatus: "completed",
  answerOutcome: "no_context_refusal",
  history: [],
};

const buildProvider = (overrides: {
  configured?: boolean;
  chipLabel?: string | (() => Promise<string>);
} = {}) => {
  const findSettings = vi.fn().mockResolvedValue({ configured: overrides.configured ?? true });
  const composeChipLabel = vi.fn().mockImplementation(async () => {
    const value = overrides.chipLabel ?? "Contact us";
    return typeof value === "function" ? value() : value;
  });
  const provider = new HumanContactActionSuggestionProvider({
    settingsService: { findSettings } as never,
    intakePrompts: { composeChipLabel } as never,
  });
  return { provider, findSettings, composeChipLabel };
};

describe("HumanContactActionSuggestionProvider", () => {
  it("has the contact_human provider name", () => {
    const { provider } = buildProvider();
    expect(provider.name).toBe("contact_human");
  });

  it("returns a contact_human chip on no_context_refusal when contact is configured", async () => {
    const { provider, composeChipLabel } = buildProvider({ chipLabel: "Contactez-nous" });
    const suggestion = await provider.evaluate(baseContext);
    expect(suggestion).toEqual({
      text: "Contactez-nous",
      kind: "contact_human",
      action: {
        kind: "start_intent",
        intent: {
          skillName: HUMAN_CONTACT_SKILL_NAME,
          intentName: "no_context_refusal",
        },
      },
    });
    expect(composeChipLabel).toHaveBeenCalledOnce();
  });

  it("returns null when contact is not configured for the workspace", async () => {
    const { provider, composeChipLabel } = buildProvider({ configured: false });
    const suggestion = await provider.evaluate(baseContext);
    expect(suggestion).toBeNull();
    expect(composeChipLabel).not.toHaveBeenCalled();
  });

  it("returns null when the answer was grounded successfully", async () => {
    const { provider, composeChipLabel } = buildProvider();
    const suggestion = await provider.evaluate({
      ...baseContext,
      skillOutcome: "grounded",
      answerOutcome: "grounded_success",
    });
    expect(suggestion).toBeNull();
    expect(composeChipLabel).not.toHaveBeenCalled();
  });

  it("returns null on grounded answers - the chip is opt-in only for strict refusals", async () => {
    const { provider, composeChipLabel } = buildProvider();
    const suggestion = await provider.evaluate({
      ...baseContext,
      skillOutcome: "grounded",
      answerOutcome: "grounded_success",
    });
    expect(suggestion).toBeNull();
    expect(composeChipLabel).not.toHaveBeenCalled();
  });

  it("returns null when chip label generation fails", async () => {
    const { provider } = buildProvider({
      chipLabel: () => Promise.reject(new Error("LLM unavailable")),
    });
    const suggestion = await provider.evaluate(baseContext);
    expect(suggestion).toBeNull();
  });
});
