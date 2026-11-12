import { describe, expect, it } from "vitest";

import { buildCopilotSystemPrompt } from "../../../src/modules/operatorCopilot/turnPrompt.js";
import { WorkspaceSetupContext, workspaceSetupContextBlock, deriveWorkspaceSetupGuidance } from "../../../src/modules/operatorCopilot/context/workspaceSetup.js";
import {
  copilotEvalSetupStates,
  evaluateCopilotAssertion,
  parseCopilotEvalCases,
  type CopilotEvalCase,
  type CopilotObservedTurn,
} from "../../support/copilotEvalSuite.js";
import { COPILOT_EVAL_SETUP_STATES, runCopilotEvalCaseDeterministically } from "../../support/copilotEvalRunner.js";
import { copilotEvalCases } from "../../fixtures/copilot-evals/cases.js";

const turnWithSetup = (state: keyof typeof COPILOT_EVAL_SETUP_STATES | null): CopilotObservedTurn => {
  const guidance = state === null ? null : deriveWorkspaceSetupGuidance(COPILOT_EVAL_SETUP_STATES[state]);
  const block = guidance ? workspaceSetupContextBlock(guidance, "sunny-co") : null;
  return {
    systemPrompt: buildCopilotSystemPrompt("You are Ray.", "sunny-co", block ? [block] : []),
    userMessage: "What should I do first?",
    exposedTools: [],
    toolCalls: [],
    proposals: [],
    finalMessage: null,
    outcome: "completed",
    conversationId: null,
  };
};

describe("setup state assertions", () => {
  it("passes when the model was told the phase, the conversation fact, and the next steps in order, each linked", () => {
    const verdict = evaluateCopilotAssertion(
      { type: "setup_in_context", phase: "setup", firstConversationHappened: false, nextSteps: ["documents", "conversation", "directives_or_routines"] },
      turnWithSetup("fresh"),
      "deterministic",
    );
    expect(verdict.status).toBe("pass");
  });

  it("fails when the model was handed a step the state reports as done", () => {
    const verdict = evaluateCopilotAssertion(
      { type: "setup_in_context", phase: "setup", firstConversationHappened: true, nextSteps: ["documents", "directives_or_routines"] },
      turnWithSetup("partly_set_up"),
      "deterministic",
    );
    expect(verdict.status).toBe("fail");
  });

  it("fails when the turn carried no setup context at all", () => {
    const verdict = evaluateCopilotAssertion(
      { type: "setup_in_context", phase: "setup", firstConversationHappened: false, nextSteps: [] },
      turnWithSetup(null),
      "deterministic",
    );
    expect(verdict.status).toBe("fail");
    expect(verdict.reason).toContain("no setup context");
  });

  it("passes setup_not_in_context only when nothing about setup reached the model", () => {
    expect(evaluateCopilotAssertion({ type: "setup_not_in_context" }, turnWithSetup("complete"), "deterministic").status).toBe("pass");
    expect(evaluateCopilotAssertion({ type: "setup_not_in_context" }, turnWithSetup("fresh"), "deterministic").status).toBe("fail");
  });
});

describe("setup state eval fixtures", () => {
  const evalCase = (overrides: Partial<CopilotEvalCase>): CopilotEvalCase => ({
    id: "setup-case",
    name: "Setup case",
    permissions: ["workspace.summary.read"],
    pageContext: { view: "other", agentId: null, conversationId: null, selection: null, entities: [] },
    message: "What should I do first?",
    plan: [],
    assertions: [{ type: "turn_outcome", outcome: "completed" }],
    ...overrides,
  });

  it("names a fixture for every setup state a case can ask for", () => {
    expect(Object.keys(COPILOT_EVAL_SETUP_STATES).sort()).toEqual([...copilotEvalSetupStates].sort());
  });

  it("gives the turn the setup context the named state implies, through the real contributor", async () => {
    const observed = await runCopilotEvalCaseDeterministically(evalCase({ setupState: "fresh" }));
    expect(observed.systemPrompt).toContain('"workspace_setup":{"phase":"setup","firstConversationHappened":false');
    expect(observed.systemPrompt).toContain("/w/sunny-co/knowledge");
  });

  it("gives a case with no named state no setup context", async () => {
    const observed = await runCopilotEvalCaseDeterministically(evalCase({}));
    expect(observed.systemPrompt).not.toContain('"workspace_setup"');
  });

  it("withholds the context from an operator who cannot read the workspace summary", async () => {
    const observed = await runCopilotEvalCaseDeterministically(evalCase({ setupState: "fresh", permissions: ["workspace.agents.read"] }));
    expect(observed.systemPrompt).not.toContain('"workspace_setup"');
  });

  it("agrees with the contributor about every fixture, so a case cannot assert a state the product would not derive", async () => {
    for (const state of copilotEvalSetupStates) {
      const direct = await new WorkspaceSetupContext({ workspaceSetupState: { getSetupSignals: async () => COPILOT_EVAL_SETUP_STATES[state] } })
        .contribute({ workspaceId: "w", workspaceKey: "sunny-co", permissions: new Set(["workspace.summary.read"]) });
      const observed = await runCopilotEvalCaseDeterministically(evalCase({ setupState: state }));
      expect(observed.systemPrompt.includes('"workspace_setup"')).toBe(direct !== null);
    }
  });
});

describe("setup state eval cases", () => {
  const cases = parseCopilotEvalCases(copilotEvalCases);

  it("covers a fresh, a partly set-up, a complete, and a dismissed-before-first-conversation workspace", () => {
    expect(cases.filter((entry) => entry.setupState).map((entry) => entry.setupState).sort()).toEqual([...copilotEvalSetupStates].sort());
  });

  it("gives every setup-state case an operator who can read the summary, or the case measures nothing", () => {
    for (const entry of cases.filter((candidate) => candidate.setupState)) {
      expect(entry.permissions).toContain("workspace.summary.read");
    }
  });
});
