import { describe, expect, it, vi } from "vitest";

import type { ConversationModelGateway, TurnContext } from "@radioso/conversation-contract";

import { RoutineStepRenderer } from "@radioso/conversation-defaults";

const turn: TurnContext = {
  agent: { id: "a", name: "Assistant" },
  sessionId: "s1",
  inputEvent: { id: "i1", kind: "message", content: "I'd like to contact a human" },
  history: [],
  stagedContext: [],
  steering: [],
};

const gateway = (text: string): ConversationModelGateway => ({ complete: vi.fn(async () => ({ text })) });

describe("RoutineStepRenderer", () => {
  it("generates the reply by following the projected step steering, trimmed", async () => {
    const gw = gateway("  What's your email address?  ");
    const result = await new RoutineStepRenderer(gw).render({
      step: { id: "ask_email", kind: "chat", action: "Ask for email." },
      steering: [{ action: "Ask the user for their email address.", source: "routine", lifespan: "response" }],
      turn,
    });

    expect(result.answer).toBe("What's your email address?");
    const call = vi.mocked(gw.complete).mock.calls[0]![0];
    expect(call.systemPrompt).toContain("Ask the user for their email address.");
    expect(call.messages.at(-1)).toEqual({ role: "user", content: "I'd like to contact a human" });
  });

  it("falls back to the step's own action when no steering is projected", async () => {
    const gw = gateway("Your request was sent.");
    await new RoutineStepRenderer(gw).render({
      step: { id: "done", kind: "terminal", action: "Confirm the request was sent." },
      steering: [],
      turn,
    });
    expect(vi.mocked(gw.complete).mock.calls[0]![0].systemPrompt).toContain("Confirm the request was sent.");
  });

  it("injects the detected response language when provided", async () => {
    const gw = gateway("What is your email address?");
    await new RoutineStepRenderer(gw, { responseLanguage: "English" }).render({
      step: { id: "ask_email", kind: "chat", action: "Ask for email." },
      steering: [],
      turn,
    });

    const call = vi.mocked(gw.complete).mock.calls[0]![0];
    expect(call.systemPrompt).toContain("Respond in English.");
    expect(call.systemPrompt).not.toContain("Always reply in the same language as the user's most recent message");
  });

  it("keeps the relative language fallback when no detected label is available", async () => {
    const gw = gateway("What is your email address?");
    await new RoutineStepRenderer(gw).render({
      step: { id: "ask_email", kind: "chat", action: "Ask for email." },
      steering: [],
      turn,
    });

    const call = vi.mocked(gw.complete).mock.calls[0]![0];
    expect(call.systemPrompt).toContain("Always reply in the same language as the user's most recent message");
    expect(call.systemPrompt).not.toContain("Respond in English.");
  });
});
