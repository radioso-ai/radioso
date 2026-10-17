import { describe, expect, it } from "vitest";

import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";
import type { TurnPlanOutcome } from "../../src/modules/chat/services/turnPlanCoordinator.js";
import { decideQuickReply } from "../../src/modules/chat/services/turnPlanQuickReply.js";
import type { TurnPlan } from "../../src/modules/chat/services/turnPlanService.js";

const plan = (overrides: Partial<TurnPlan> = {}): TurnPlan => ({
  route: "direct",
  framing: { isIdentityQuestion: false },
  responseLanguage: "English",
  routineRankings: [],
  directiveClassifications: [],
  requestPresent: false,
  openQuestion: false,
  rewritePresent: false,
  quickReply: { kind: "greeting", language: "en", text: "Hello! How can I help today?", standingDirectiveNames: [] },
  ...overrides,
});

const session = (input: { utterance?: string; plan?: TurnPlan; agent?: Record<string, unknown> } = {}): PreparedSession => {
  const outcome: TurnPlanOutcome = { status: "planned", plan: input.plan ?? plan(), prepared: null };
  return {
    turnRoute: "direct",
    turnPlan: { resolve: async () => outcome, bypass: () => {} },
    userMessage: { id: "message-1", content: input.utterance ?? "Hello!" },
    history: [],
    agent: { id: "agent-1", name: "Acme Support", customInstruction: "", mechanicsReplies: {}, assistantDefaultLocale: null, ...input.agent },
    directiveSteering: { rules: [], matches: [], omissions: [] },
  } as unknown as PreparedSession;
};

describe("decideQuickReply guards", () => {
  it("uses the planner's reply when every guard holds", async () => {
    await expect(decideQuickReply(session())).resolves.toMatchObject({
      kind: "use",
      quickReply: { kind: "greeting", text: "Hello! How can I help today?", wording: "planner" },
    });
  });

  it("composes when the plan wrote a retrieval rewrite, whichever route it chose", async () => {
    await expect(decideQuickReply(session({ plan: plan({ rewritePresent: true }) })))
      .resolves.toMatchObject({ kind: "skip", reason: "rewrite_present" });
  });

  it("composes when the planner says the message carries a request", async () => {
    await expect(decideQuickReply(session({
      utterance: "Good morning! I'd like to cancel my subscription.",
      plan: plan({ requestPresent: true }),
    }))).resolves.toMatchObject({ kind: "skip", reason: "request_present" });
  });

  it("composes when the planner's text fails the structural gate", async () => {
    await expect(decideQuickReply(session({
      plan: plan({ quickReply: { kind: "greeting", language: "en", text: "Welcome! Pro costs $99 and is SOC 2 certified.", standingDirectiveNames: [] } }),
    }))).resolves.toMatchObject({ kind: "skip", reason: "text_digit" });
  });

  it("speaks the agent's authored line for the mechanic and ignores the planner's text", async () => {
    const mechanicsReplies = {
      it: { greeting: ["Ciao! Come posso aiutarti?", "Ciao, benvenuto!"], thanks: [], farewell: [], acknowledgement: [] },
    };
    const decision = await decideQuickReply(session({
      utterance: "Ciao!",
      plan: plan({
        responseLanguage: "Italian",
        quickReply: { kind: "greeting", language: "it", text: "Welcome! Pro costs $99 and is SOC 2 certified.", standingDirectiveNames: [] },
      }),
      agent: { mechanicsReplies },
    }));

    expect(decision).toEqual({
      kind: "use",
      quickReply: { kind: "greeting", text: "Ciao! Come posso aiutarti?", wording: "authored" },
    });
  });

  it("looks authored lines up by the planner's tag alone, whatever the page, browser, or agent locale", async () => {
    const mechanicsReplies = {
      en: { greeting: ["Hi there!"], thanks: [], farewell: [], acknowledgement: [] },
      "en-US": { greeting: ["Howdy!"], thanks: [], farewell: [], acknowledgement: [] },
    };
    const base = session({ agent: { mechanicsReplies, assistantDefaultLocale: "en-US" } });
    const fromUsBrowser = { ...base, pageContext: { pageLocale: "en-US", browserLocale: "en-US" } } as PreparedSession;

    await expect(decideQuickReply(fromUsBrowser)).resolves.toEqual({
      kind: "use",
      quickReply: { kind: "greeting", text: "Hi there!", wording: "authored" },
    });
  });

  it("rotates authored lines with the number of replies the conversation already has", async () => {
    const mechanicsReplies = {
      en: { greeting: ["Hi there!", "Hello again!"], thanks: [], farewell: [], acknowledgement: [] },
    };
    const base = session({ agent: { mechanicsReplies } });
    const second = { ...base, history: [{ role: "user", content: "Hi" }, { role: "assistant", content: "Hi there!" }] } as PreparedSession;

    await expect(decideQuickReply(second)).resolves.toMatchObject({ kind: "use", quickReply: { text: "Hello again!", wording: "authored" } });
  });

  it("composes when the assistant's question is still open", async () => {
    await expect(decideQuickReply(session({ plan: plan({ openQuestion: true }) })))
      .resolves.toMatchObject({ kind: "skip", reason: "open_question" });
  });
});
