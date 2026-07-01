import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type {
  ConversationModelGateway,
  Routine,
  RoutineState,
  RoutineStep,
  RoutineTransition,
  TurnContext,
} from "@radioso/conversation-contract";
import {
  DEFAULT_DIRECTIVE_MATCH_SYSTEM_PROMPT,
  DEFAULT_ROUTINE_NEXT_STEP_PROMPT,
  DEFAULT_ROUTINE_STEP_TERMINAL_HANDOFF_DEFAULT_PROMPT,
  DEFAULT_ROUTINE_STEP_TERMINAL_HANDOFF_WITH_MESSAGE_PROMPT,
  DEFAULT_ROUTINE_STEP_REPLY_PROMPT,
  InMemoryConversationRoutineStore,
  RoutineNextStepSelector,
  RoutineRegistry,
  RoutineStepRenderer,
} from "../src/index.js";

const turn: TurnContext = {
  agent: { id: "a", name: "Assistant" },
  sessionId: "s1",
  inputEvent: { id: "i1", kind: "message", content: "alex@example.com" },
  history: [{ role: "assistant", content: "What is your email?" }],
  stagedContext: [],
  steering: [],
};
const routine: Routine = { id: "contact", rootStepId: "ask_email", steps: [], transitions: [] };
const currentStep: RoutineStep = { id: "ask_email", kind: "chat", action: "Ask for the user's email." };
const transitions: RoutineTransition[] = [
  { from: "ask_email", to: "ask_message", condition: "a valid email was provided" },
];
const state: RoutineState = { sessionId: "s1", routineId: "contact", path: ["ask_email"], variables: {}, status: "active" };

const gateway = (text: string): ConversationModelGateway => ({ complete: vi.fn(async () => ({ text })) });
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDirectory, "../../..");
const backendPrompt = (relativePath: string): string =>
  readFileSync(path.resolve(repoRoot, "backend/prompts", relativePath), "utf8").trimEnd();

describe("routine defaults", () => {
  it("exports non-empty package fallback prompts", () => {
    expect(DEFAULT_DIRECTIVE_MATCH_SYSTEM_PROMPT.trim()).not.toBe("");
    expect(DEFAULT_ROUTINE_NEXT_STEP_PROMPT.trim()).not.toBe("");
    expect(DEFAULT_ROUTINE_STEP_REPLY_PROMPT.trim()).not.toBe("");
  });

  it("keeps package fallback prompts byte-equal to the backend prompt files", () => {
    expect(DEFAULT_DIRECTIVE_MATCH_SYSTEM_PROMPT).toBe(backendPrompt("chat/directive-match.md"));
    expect(DEFAULT_ROUTINE_NEXT_STEP_PROMPT).toBe(backendPrompt("chat/routine-next-step.md"));
    expect(DEFAULT_ROUTINE_STEP_REPLY_PROMPT).toBe(backendPrompt("chat/routine-step-reply.md"));
    expect(DEFAULT_ROUTINE_STEP_TERMINAL_HANDOFF_WITH_MESSAGE_PROMPT)
      .toBe(backendPrompt("chat/routine-step-terminal-handoff-with-message.md"));
    expect(DEFAULT_ROUTINE_STEP_TERMINAL_HANDOFF_DEFAULT_PROMPT)
      .toBe(backendPrompt("chat/routine-step-terminal-handoff-default.md"));
  });

  it("keeps generated fallback prompt artifacts current", () => {
    const result = spawnSync("node", ["scripts/generate-default-prompts.mjs", "--check"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it("activates the ranked routine selected by the shared matcher", async () => {
    const activationGateway = gateway(JSON.stringify({
      matches: [
        { routineId: "a", confidence: 0.1 },
        { routineId: "b", confidence: 0.9, variables: { email: "x@y.z" } },
      ],
    }));
    const registry = new RoutineRegistry([
      { routine: { ...routine, id: "a" }, trigger: { description: "Start a", priority: 0 } },
      { routine: { ...routine, id: "b" }, trigger: { description: "Start b", priority: 0 } },
    ]);

    expect(registry.routines.map((candidate) => candidate.id)).toEqual(["a", "b"]);
    expect(registry.isEmpty).toBe(false);
    await expect(registry.activator(activationGateway).activate({ turn })).resolves.toMatchObject({
      kind: "activate",
      routineId: "b",
      variables: { email: "x@y.z" },
      decisionMetadata: {
        decision: { kind: "auto_pick", reason: "clear_margin" },
      },
    });
    expect(activationGateway.complete).toHaveBeenCalledTimes(1);
  });

  it("selects a transition from balanced JSON output and captures variables", async () => {
    const selector = new RoutineNextStepSelector(gateway('Reasoning: {"condition": 1, "variables": {"email": "a@b.c"}} done.'));
    await expect(selector.select({ routine, state, currentStep, transitions, turn })).resolves.toEqual({
      nextStepId: "ask_message",
      variables: { email: "a@b.c" },
    });
  });

  it("stays put without calling the model when there are no outgoing transitions", async () => {
    const gw = gateway("{}");
    const decision = await new RoutineNextStepSelector(gw).select({ routine, state, currentStep, transitions: [], turn });
    expect(decision.nextStepId).toBe("ask_email");
    expect(gw.complete).not.toHaveBeenCalled();
  });

  it("yields the turn when the model marks the latest message off-topic", async () => {
    const decision = await new RoutineNextStepSelector(
      gateway('{"condition": null, "offTopic": true, "variables": {}}'),
    ).select({ routine, state, currentStep, transitions, turn });
    expect(decision).toEqual({ nextStepId: "ask_email", yieldTurn: true });
  });

  it("follows a decline transition instead of yielding or re-asking", async () => {
    const declineTransitions: RoutineTransition[] = [
      { from: "ask_email", to: "cancelled", condition: "the user declined, cancelled, refused, or wants to stop" },
    ];
    const decision = await new RoutineNextStepSelector(
      gateway('{"condition": 1, "offTopic": false, "variables": {}}'),
    ).select({ routine, state, currentStep, transitions: declineTransitions, turn });
    expect(decision).toEqual({ nextStepId: "cancelled", variables: {} });
  });

  it("throws when a prompt template leaves a variable unfilled", async () => {
    const selector = new RoutineNextStepSelector(gateway("{}"), {
      promptTemplate: "{{currentStep}}\n{{missing}}",
    });

    await expect(selector.select({ routine, state, currentStep, transitions, turn })).rejects.toThrow(
      'Missing prompt variable "missing" for template chat/routine-next-step.md',
    );
  });

  it("substitutes prompt variables in a single pass", async () => {
    const gw = gateway("ok");
    await new RoutineStepRenderer(gw, { promptTemplate: "{{instructions}}" }).render({
      step: { ...currentStep, action: "Ask literally for {{missing}}." },
      steering: [],
      turn,
    });

    expect(vi.mocked(gw.complete).mock.calls[0]![0].systemPrompt).toBe("- Ask literally for {{missing}}.");
  });

  it("renders a step reply through the model gateway and trims it", async () => {
    const gw = gateway("  What's your email address?  ");
    const result = await new RoutineStepRenderer(gw).render({
      step: currentStep,
      steering: [{ action: "Ask the user for their email address.", source: "routine", lifespan: "response" }],
      turn,
    });

    expect(result.answer).toBe("What's your email address?");
    expect(vi.mocked(gw.complete).mock.calls[0]?.[0].systemPrompt).toContain("Ask the user for their email address.");
  });

  it("delegates retrieval-grounded routine replies to the host renderer when available", async () => {
    const gw = gateway("generic reply");
    const groundedAnswerRenderer = {
      render: vi.fn(async () => ({ answer: "Grounded reply.", metadata: { renderedBy: "grounded" } })),
    };
    const stagedTurn: TurnContext = {
      ...turn,
      stagedContext: [{
        kind: "skill_result",
        source: "retrieval.context",
        data: {
          has_context: true,
          contexts: [{ title: "Course Guide", content: "Kriya is introduced in the first module." }],
        },
      }],
    };

    const result = await new RoutineStepRenderer(gw, { groundedAnswerRenderer }).render({
      step: currentStep,
      steering: [{ action: "Answer from context, then say Hop.", source: "routine", lifespan: "response" }],
      turn: stagedTurn,
    });

    expect(result).toEqual({ answer: "Grounded reply.", metadata: { renderedBy: "grounded" } });
    expect(groundedAnswerRenderer.render).toHaveBeenCalledWith({
      step: currentStep,
      steering: [{ action: "Answer from context, then say Hop.", source: "routine", lifespan: "response" }],
      turn: stagedTurn,
    });
    expect(gw.complete).not.toHaveBeenCalled();
  });

  it("falls back to generic routine reply generation when the host grounded renderer declines", async () => {
    const gw = gateway("generic reply");
    const groundedAnswerRenderer = {
      render: vi.fn(async () => null),
    };

    const result = await new RoutineStepRenderer(gw, { groundedAnswerRenderer }).render({
      step: currentStep,
      steering: [{ action: "Ask the user for their email address.", source: "routine", lifespan: "response" }],
      turn,
    });

    expect(result.answer).toBe("generic reply");
    expect(groundedAnswerRenderer.render).toHaveBeenCalledOnce();
    expect(gw.complete).toHaveBeenCalledOnce();
  });

  it("renders handoff terminals with an authored message through the terminal-only prompt", async () => {
    const gw = gateway("I’m bringing in a teammate.");
    const groundedAnswerRenderer = {
      render: vi.fn(async () => ({ answer: "Grounded reply." })),
    };
    await new RoutineStepRenderer(gw, { groundedAnswerRenderer, responseLanguage: "English" }).render({
      step: {
        id: "handoff",
        kind: "terminal",
        action: "Bringing in a teammate.",
        metadata: { terminalKind: "handoff" },
      },
      steering: [{ action: "Bringing in a teammate.", source: "routine", lifespan: "response" }],
      turn: {
        ...turn,
        stagedContext: [{
          kind: "skill_result",
          source: "retrieval.context",
          data: { contexts: [{ title: "Contact", content: "Call reception." }] },
        }],
      },
    });

    const call = vi.mocked(gw.complete).mock.calls[0]![0];
    expect(call.systemPrompt).toContain("Write one short message in English");
    expect(call.systemPrompt).toContain("Bringing in a teammate.");
    expect(call.systemPrompt).toContain("Do not add links, contact details");
    expect(call.systemPrompt).not.toContain("What is your email?");
    expect(call.systemPrompt).not.toContain("Call reception.");
    expect(call.systemPrompt).not.toContain("Step instruction(s)");
    expect(call.messages).toEqual([{ role: "user", content: "Write the handoff message." }]);
    expect(groundedAnswerRenderer.render).not.toHaveBeenCalled();
  });

  it("renders handoff terminals without an authored message through the default terminal prompt", async () => {
    const gw = gateway("A person will connect soon.");
    await new RoutineStepRenderer(gw, { responseLanguage: "Italian" }).render({
      step: {
        id: "handoff",
        kind: "terminal",
        action: "",
        metadata: { terminalKind: "handoff" },
      },
      steering: [],
      turn,
    });

    const call = vi.mocked(gw.complete).mock.calls[0]![0];
    expect(call.systemPrompt).toContain("Write one short message in Italian");
    expect(call.systemPrompt).toContain("saying that a person will connect to the chat soon");
    expect(call.systemPrompt).toContain("Do not add links, contact details");
    expect(call.systemPrompt).not.toContain("What is your email?");
    expect(call.messages).toEqual([{ role: "user", content: "Write the handoff message." }]);
  });

  it("does not treat directive steering as authored handoff terminal copy", async () => {
    const gw = gateway("A person will connect soon.");
    await new RoutineStepRenderer(gw, { responseLanguage: "English" }).render({
      step: {
        id: "handoff",
        kind: "terminal",
        metadata: { terminalKind: "handoff" },
      },
      steering: [{ action: "Ask for the user's email.", source: "directive", lifespan: "response" }],
      turn,
    });

    const call = vi.mocked(gw.complete).mock.calls[0]![0];
    expect(call.systemPrompt).toContain("saying that a person will connect to the chat soon");
    expect(call.systemPrompt).not.toContain("Ask for the user's email.");
  });

  it("passes only the latest user message as a language hint when no response language is available", async () => {
    const gw = gateway("Una persona si collegherà presto.");
    await new RoutineStepRenderer(gw).render({
      step: {
        id: "handoff",
        kind: "terminal",
        action: "",
        metadata: { terminalKind: "handoff" },
      },
      steering: [],
      turn: {
        ...turn,
        inputEvent: { id: "i2", kind: "message", content: "sì" },
        history: [{ role: "user", content: "I want to visit a car festival" }],
        stagedContext: [{
          kind: "skill_result",
          source: "retrieval.context",
          data: { contexts: [{ title: "Festival", content: "Festival details and contact info." }] },
        }],
      },
    });

    const call = vi.mocked(gw.complete).mock.calls[0]![0];
    expect(call.systemPrompt).toContain("Write one short message in the user's language");
    expect(call.messages).toEqual([{
      role: "user",
      content: "Latest user message for language detection only:\nsì\n\nWrite the handoff message.",
    }]);
    expect(call.messages.map((message) => message.content).join("\n")).not.toContain("car festival");
    expect(call.messages.map((message) => message.content).join("\n")).not.toContain("Festival details");
  });

  it("does not add handoff terminal rules to ordinary routine replies", async () => {
    const gw = gateway("ok");
    await new RoutineStepRenderer(gw).render({
      step: currentStep,
      steering: [{ action: "Ask the user for their email address.", source: "routine", lifespan: "response" }],
      turn,
    });

    const systemPrompt = vi.mocked(gw.complete).mock.calls[0]![0].systemPrompt;
    expect(systemPrompt).not.toContain("This handoff has already been selected");
    expect(systemPrompt).not.toContain("Do not ask whether the user wants to be connected");
  });

  it("passes staged retrieval context as untrusted message data, not system instructions", async () => {
    const gw = gateway("ok");
    await new RoutineStepRenderer(gw).render({
      step: currentStep,
      steering: [{ action: "Answer from context.", source: "routine", lifespan: "response" }],
      turn: {
        ...turn,
        stagedContext: [{
          kind: "skill_result",
          source: "retrieval.context",
          data: {
            has_context: true,
            contexts: [{ title: "Course Guide", content: "Kriya is introduced in the first module." }],
            citations: [{ title: "Course Guide", documentId: "doc_1", chunkId: "chunk_1" }],
          },
        }],
      },
    });

    const call = vi.mocked(gw.complete).mock.calls[0]![0];
    expect(call.systemPrompt).toContain("untrusted quoted data");
    expect(call.systemPrompt).not.toContain("Course Guide");
    expect(call.systemPrompt).not.toContain("Kriya is introduced");
    expect(call.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("Retrieved document excerpts follow"),
      }),
    ]));
    expect(call.messages.map((message) => message.content).join("\n")).toContain("Course Guide");
    expect(call.messages.map((message) => message.content).join("\n")).toContain("Kriya is introduced");
  });

  it("returns citations from staged retrieval context so a grounded routine step can cite", async () => {
    const gw = gateway("Here is the answer.");
    const result = await new RoutineStepRenderer(gw).render({
      step: currentStep,
      steering: [{ action: "Answer from context.", source: "routine", lifespan: "response" }],
      turn: {
        ...turn,
        stagedContext: [{
          kind: "skill_result",
          source: "retrieval.context",
          data: {
            has_context: true,
            contexts: [
              {
                documentId: "doc_1",
                chunkId: "chunk_1",
                title: "Course Guide",
                content: "Kriya is introduced in the first module.",
                metadata: { sourceUrl: "https://example.com/guide" },
              },
            ],
          },
        }],
      },
    });

    expect(result.citations).toEqual([
      {
        documentId: "doc_1",
        chunkId: "chunk_1",
        title: "Course Guide",
        content: "Kriya is introduced in the first module.",
        metadata: { sourceUrl: "https://example.com/guide" },
      },
    ]);
  });

  it("omits citations when the step had no staged retrieval context", async () => {
    const gw = gateway("ok");
    const result = await new RoutineStepRenderer(gw).render({
      step: currentStep,
      steering: [{ action: "Ask the user for their email address.", source: "routine", lifespan: "response" }],
      turn,
    });
    expect(result.citations).toBeUndefined();
  });

  it("injects the agent scope and an out-of-scope decline rule into the routine reply prompt", async () => {
    const gw = gateway("ok");
    const scopedTurn: TurnContext = {
      ...turn,
      agent: { id: "a", name: "Ananda", instructions: ["Help only with Ananda Europe programs and events."] },
    };
    await new RoutineStepRenderer(gw).render({
      step: currentStep,
      steering: [{ action: "Ask the user for their email address.", source: "routine", lifespan: "response" }],
      turn: scopedTurn,
    });

    const systemPrompt = vi.mocked(gw.complete).mock.calls[0]![0].systemPrompt;
    expect(systemPrompt).toContain("Ananda");
    expect(systemPrompt).toContain("Help only with Ananda Europe programs and events.");
    expect(systemPrompt).toContain("do not answer or perform it");
    expect(systemPrompt).toContain("Never produce off-scope content");
  });

  it("keeps only declared slots when a routine declares a slot schema", async () => {
    const slotted: Routine = {
      ...routine,
      slots: [{ id: "s_email", key: "email", type: "email", required: true }],
    };
    const selector = new RoutineNextStepSelector(
      gateway('{"condition": 1, "variables": {"email": "a@b.c", "message": "write me code", "<name>": "x"}}'),
    );

    await expect(selector.select({ routine: slotted, state, currentStep, transitions, turn })).resolves.toEqual({
      nextStepId: "ask_message",
      variables: { email: "a@b.c" },
    });
  });

  it("drops echoed placeholder keys even when no slot schema is declared", async () => {
    const selector = new RoutineNextStepSelector(
      gateway('{"condition": 1, "variables": {"email": "a@b.c", "<name>": "x"}}'),
    );

    await expect(selector.select({ routine, state, currentStep, transitions, turn })).resolves.toEqual({
      nextStepId: "ask_message",
      variables: { email: "a@b.c" },
    });
  });

  it("expires active routine state after the configured TTL", async () => {
    let now = 1000;
    const store = new InMemoryConversationRoutineStore({ ttlMs: 50, now: () => now });
    await store.save(state);
    await expect(store.loadActive({ sessionId: "s1" })).resolves.toEqual(state);

    now = 1050;
    await expect(store.loadActive({ sessionId: "s1" })).resolves.toBeNull();
  });

  it("does not load completed or explicitly expired routine state", async () => {
    const store = new InMemoryConversationRoutineStore();

    await store.save({ ...state, status: "completed" });
    await expect(store.loadActive({ sessionId: "s1" })).resolves.toBeNull();
    await expect(store.loadCompleted({ sessionId: "s1" })).resolves.toEqual([{ ...state, status: "completed" }]);

    await store.save({ ...state, status: "expired" });
    await expect(store.loadActive({ sessionId: "s1" })).resolves.toBeNull();
    await expect(store.loadCompleted({ sessionId: "s1" })).resolves.toEqual([]);
  });
});
