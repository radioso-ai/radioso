import { describe, expect, it, vi } from "vitest";

import type { AuthoredDirective } from "../../../src/modules/agents/authoredDirectives.js";
import type { AgentSkillSpine } from "../../../src/modules/agentSkills/public.js";
import {
  createAgentCapabilitiesReader,
  describeAgentCapabilities,
  type AgentCapabilities,
} from "../../../src/modules/chat/services/agentCapabilities.js";
import { buildAssistantReplyPrompt } from "../../../src/modules/chat/services/assistantReplyPromptBuilder.js";
import type { PreparedSession } from "../../../src/modules/chat/services/chatSessionPreparer.js";
import { compileRoutineDefinition, startableRoutineCapabilities } from "../../../src/modules/routines/public.js";
import { CHAT_TURN_ROUTE } from "../../../src/shared/domain/chatTurnRoute.js";
import { bookDemoRoutine } from "../../fixtures/conversation-quality/routines.js";

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

/** The book-demo routine as the routine provider registers it for a turn. */
const bookDemoRegistration = {
  routine: compileRoutineDefinition(bookDemoRoutine),
  trigger: { description: bookDemoRoutine.activation.triggerDescription, priority: bookDemoRoutine.activation.priority },
};

const agentWith = (overrides: Partial<Parameters<typeof describeAgentCapabilities>[0]> = {}) => ({
  retrievalEnabled: true,
  authoredDirectives: [orderLookupDirective],
  authoredAgentSkills: [orderStatusSkill],
  ...overrides,
});

const directReplyPrompt = (query: string, isIdentityQuestion: boolean, capabilities: AgentCapabilities): string =>
  buildAssistantReplyPrompt({
    route: CHAT_TURN_ROUTE.DIRECT,
    responseIdentity: { name: "Acme Support" },
    answerInstructionBlock: "Configured response instructions:\nHelp Acme customers.",
    history: [],
    query,
    framing: { isIdentityQuestion },
    capabilities,
  });

const sessionFor = (agentRevisionId: string | null): PreparedSession => ({
  agent: { id: "agent-1", ...agentWith() },
  conversation: { id: "conversation-1", workspaceId: "workspace-1", agentRevisionId },
  previewRoutineIds: ["routine-draft-1"],
}) as unknown as PreparedSession;

describe("a direct reply to what the agent can do (#1872)", () => {
  it("knows the routines the turn could start and the skills its directives use, but none of their internals", () => {
    const prompt = directReplyPrompt(
      "Can it take actions, or is it just a chatbot?",
      true,
      describeAgentCapabilities(agentWith(), startableRoutineCapabilities([bookDemoRegistration])),
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

  it("introduces no routine by its id when the routine carries no authored name", () => {
    const unnamed = { ...bookDemoRegistration, routine: { ...bookDemoRegistration.routine, metadata: {} } };

    expect(startableRoutineCapabilities([unnamed])).toEqual([]);
  });

  it("lists no skill whose directive or skill is switched off", () => {
    const skillOff = describeAgentCapabilities(agentWith({ authoredAgentSkills: [{ ...orderStatusSkill, enabled: false }] }), []);
    const directiveOff = describeAgentCapabilities(
      agentWith({ authoredDirectives: [{ ...orderLookupDirective, enabled: false }] }),
      [],
    );

    expect(skillOff.skills).toEqual([]);
    expect(directiveOff.skills).toEqual([]);
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
      describeAgentCapabilities(agentWith(), startableRoutineCapabilities([bookDemoRegistration])),
    );

    expect(prompt).not.toContain(bookDemoRoutine.name);
    expect(prompt).not.toContain("order_status");
  });

  it("reads the routines the turn's release and workbench preview could start", async () => {
    const describeStartable = vi.fn(async () => startableRoutineCapabilities([bookDemoRegistration]));
    const read = createAgentCapabilitiesReader({ describeStartable });

    const capabilities = await read(sessionFor("revision-1"));

    expect(describeStartable).toHaveBeenCalledWith({
      agentId: "agent-1",
      agentRevisionId: "revision-1",
      workspaceId: "workspace-1",
      previewRoutineIds: ["routine-draft-1"],
    });
    expect(capabilities?.routines).toEqual([{ name: bookDemoRoutine.name, trigger: bookDemoRoutine.activation.triggerDescription }]);
  });

  it("reads no capabilities when the routines cannot be read, so the reply states no limit", async () => {
    const warn = vi.fn();
    const read = createAgentCapabilitiesReader(
      { describeStartable: vi.fn(async () => { throw new Error("database unavailable"); }) },
      { warn },
    );

    await expect(read(sessionFor(null))).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "agent_capabilities_unavailable", conversationId: "conversation-1" }),
      expect.any(String),
    );
  });
});
