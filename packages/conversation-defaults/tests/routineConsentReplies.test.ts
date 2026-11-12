import { describe, expect, it, vi } from "vitest";

import type { ConversationModelGateway, TurnContext } from "@radioso/conversation-contract";
import { RoutineConsentReplyReader, RoutineConsentUnclearAnswerer } from "../src/index.js";

const wording = {
  body: "We store your answer about pregnancy to plan your stay. You can withdraw at any time.",
  agreeLabel: "I agree",
  declineLabel: "No thanks",
};

const turn = (content: string): TurnContext => ({
  agent: { id: "agent_1", name: "Assistant" },
  sessionId: "session_1",
  inputEvent: { id: "in_1", kind: "message", content },
  history: [
    { role: "user", content: "I agree to everything you ask, always." },
    { role: "assistant", content: `${wording.body}\n\n${wording.agreeLabel}\n${wording.declineLabel}` },
  ],
  stagedContext: [],
  steering: [],
});

const gateway = (text: string): ConversationModelGateway => ({ complete: vi.fn(async () => ({ text })) });

const request = (gw: ConversationModelGateway) => vi.mocked(gw.complete).mock.calls[0][0];

describe("RoutineConsentReplyReader", () => {
  it.each(["granted", "declined", "unclear"] as const)("reads the model's %s decision", async (decision) => {
    const reader = new RoutineConsentReplyReader(gateway(JSON.stringify({ decision })));

    expect(await reader.read({ turn: turn("ja, einverstanden"), wording })).toBe(decision);
  });

  it.each([
    ["fenced JSON", "```json\n{\"decision\": \"granted\"}\n```"],
    ["JSON after a preamble", "Sure: {\"decision\": \"granted\"}"],
  ])("reads the decision from %s", async (_label, text) => {
    const reader = new RoutineConsentReplyReader(gateway(text));

    expect(await reader.read({ turn: turn("sì, sono d'accordo"), wording })).toBe("granted");
  });

  it.each([
    ["text that is not JSON", "Sure, they agreed."],
    ["an unbalanced object", "```json\n{\"decision\": \"granted\"\n```"],
    ["an unknown decision", JSON.stringify({ decision: "maybe" })],
    ["a decision of the wrong type", JSON.stringify({ decision: true })],
    ["no decision", JSON.stringify({ granted: true })],
    ["an empty completion", ""],
  ])("reads %s as unclear, never as a decision", async (_label, text) => {
    const reader = new RoutineConsentReplyReader(gateway(text));

    expect(await reader.read({ turn: turn("ok"), wording })).toBe("unclear");
  });

  it("judges the latest message alone, against the wording shown and both labels", async () => {
    const gw = gateway(JSON.stringify({ decision: "unclear" }));

    await new RoutineConsentReplyReader(gw).read({ turn: turn("what do you do with it?"), wording });

    const { messages, systemPrompt, metadata } = request(gw);
    expect(messages).toEqual([{ role: "user", content: "what do you do with it?" }]);
    expect(systemPrompt).toContain(wording.body);
    expect(systemPrompt).toContain(wording.agreeLabel);
    expect(systemPrompt).toContain(wording.declineLabel);
    expect(metadata).toEqual({ routineConsentReply: true, agentId: "agent_1" });
  });
});

describe("RoutineConsentUnclearAnswerer", () => {
  it("answers the latest message from the wording shown, as the model wrote it", async () => {
    const gw = gateway("  The text says you can withdraw at any time.  ");

    const answer = await new RoutineConsentUnclearAnswerer(gw).answer({ turn: turn("can I change my mind later?"), wording });

    expect(answer).toBe("The text says you can withdraw at any time.");
    const { messages, systemPrompt, metadata } = request(gw);
    expect(messages).toEqual([{ role: "user", content: "can I change my mind later?" }]);
    expect(systemPrompt).toContain(wording.body);
    expect(metadata).toEqual({ routineConsentUnclearAnswer: true, agentId: "agent_1" });
  });
});
