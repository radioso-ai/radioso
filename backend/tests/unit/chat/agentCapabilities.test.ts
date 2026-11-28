import { describe, expect, it } from "vitest";

import type { AuthoredDirective } from "../../../src/modules/agents/authoredDirectives.js";
import type { AgentSkillSpine } from "../../../src/modules/agentSkills/public.js";
import { describeAgentCapabilities } from "../../../src/modules/chat/services/agentCapabilities.js";
import { buildAssistantReplyPrompt } from "../../../src/modules/chat/services/assistantReplyPromptBuilder.js";
import { CHAT_TURN_ROUTE } from "../../../src/shared/domain/chatTurnRoute.js";
import { bookDemoRoutine, startReturnRoutine } from "../../fixtures/conversation-quality/routines.js";

const FIXED_DATE = new Date("2026-01-01T00:00:00.000Z");

const orderLookupDirective: AuthoredDirective = {
  id: "directive:order-lookup",
  agentId: "agent-1",
  name: "order-lookup",
  condition: { kind: "contextual", description: "the visitor asks where their order is" },
  action: "Look the order up before answering.",
  priority: null,
  requiredCapabilities: [],
  dependsOn: [],
  excludes: [],
  routes: [],
  surfaces: [],
  tags: [],
  description: null,
  binding: { kind: "skill", skillName: "order_status" },
  lifecycle: null,
  enabled: true,
  metadata: {},
  createdAt: FIXED_DATE,
  updatedAt: FIXED_DATE,
};

const orderStatusSkill: AgentSkillSpine = {
  id: "00000000-0000-4000-8000-000000000001",
  agentId: "agent-1",
  workspaceId: "workspace-1",
  skillName: "order_status",
  kind: "external_mcp",
  invocationMode: "agent_selectable",
  enabled: true,
  createdAt: FIXED_DATE,
  updatedAt: FIXED_DATE,
};

const switchedOffRoutine = { ...startReturnRoutine, enabled: false };

const agentWith = (overrides: Partial<Parameters<typeof describeAgentCapabilities>[0]> = {}) => ({
  retrievalEnabled: true,
  authoredDirectives: [orderLookupDirective],
  authoredAgentSkills: [orderStatusSkill],
  ...overrides,
});

const directReplyPrompt = (
  query: string,
  isIdentityQuestion: boolean,
  capabilities: ReturnType<typeof describeAgentCapabilities>,
): string =>
  buildAssistantReplyPrompt({
    route: CHAT_TURN_ROUTE.DIRECT,
    responseIdentity: { name: "Acme Support" },
    answerInstructionBlock: "Configured response instructions:\nHelp Acme customers.",
    history: [],
    query,
    framing: { isIdentityQuestion },
    capabilities,
  });

describe("a direct reply to what the agent can do (#1872)", () => {
  it("knows the agent's live routines and the skills its directives use, but none of their internals", () => {
    const prompt = directReplyPrompt(
      "Can it take actions, or is it just a chatbot?",
      true,
      describeAgentCapabilities(agentWith(), [bookDemoRoutine, switchedOffRoutine]),
    );

    expect(prompt).toContain(bookDemoRoutine.name);
    expect(prompt).toContain(bookDemoRoutine.activation.triggerDescription);
    expect(prompt).toContain("order_status");
    expect(prompt).toContain("the visitor asks where their order is");
    for (const step of bookDemoRoutine.steps) {
      expect(prompt).not.toContain(step.instruction);
    }
    for (const slot of bookDemoRoutine.slots) {
      expect(prompt).not.toContain(slot.description);
    }
    expect(prompt).not.toContain(orderLookupDirective.action);
  });

  it("lists no routine the operator switched off and no skill whose directive or skill is off", () => {
    const capabilities = describeAgentCapabilities(
      agentWith({ authoredAgentSkills: [{ ...orderStatusSkill, enabled: false }] }),
      [switchedOffRoutine],
    );
    const disabledDirective = describeAgentCapabilities(
      agentWith({ authoredDirectives: [{ ...orderLookupDirective, enabled: false }] }),
      [],
    );

    expect(capabilities.routines).toEqual([]);
    expect(capabilities.skills).toEqual([]);
    expect(disabledDirective.skills).toEqual([]);
  });

  it("keeps a bound skill when the release recorded no skills, as the turn resolves it live", () => {
    const capabilities = describeAgentCapabilities(agentWith({ authoredAgentSkills: undefined }), []);

    expect(capabilities.skills).toEqual([{ name: "order_status", usedWhen: "the visitor asks where their order is" }]);
  });

  it("answers from documents only when the agent's retrieval is on", () => {
    expect(describeAgentCapabilities(agentWith(), []).answersFromDocuments).toBe(true);
    expect(describeAgentCapabilities(agentWith({ retrievalEnabled: false }), []).answersFromDocuments).toBe(false);
  });

  it("leaves the capabilities out of a direct reply that does not ask about the assistant", () => {
    const prompt = directReplyPrompt(
      "Thanks, that helps!",
      false,
      describeAgentCapabilities(agentWith(), [bookDemoRoutine]),
    );

    expect(prompt).not.toContain(bookDemoRoutine.name);
    expect(prompt).not.toContain("order_status");
  });
});
