import { describe, expect, it, vi } from "vitest";

import type { RoutineState } from "@radioso/conversation-contract";

import type { AuthoredDirective } from "../../../src/modules/agents/authoredDirectives.js";
import type { AgentRecord } from "../../../src/modules/agents/public.js";
import {
  agentCapabilitiesHandle,
  type AgentCapabilities,
  type AgentCapabilitySources,
} from "../../../src/modules/chat/services/agentCapabilities.js";
import { buildAssistantReplyPrompt } from "../../../src/modules/chat/services/assistantReplyPromptBuilder.js";
import type { DirectiveBindingAvailability, DirectiveBindingSkillState } from "../../../src/modules/chat/services/directiveBindingResolution.js";
import type { MessageRecord } from "../../../src/db/repositories/messageRepository.js";
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

const turnSkillState: DirectiveBindingSkillState = { enabled: true, turnCapable: true, stagingCapable: false };

const availabilityWith = (state: DirectiveBindingSkillState | null, registered = state?.turnCapable ?? false): DirectiveBindingAvailability => ({
  registeredTurnSkillNames: new Set(registered ? ["order_status"] : []),
  agentSkillStates: new Map(state ? [["order_status", state]] : []),
});

/** The book-demo routine as the routine provider describes it for a conversation. */
const bookDemo = startableRoutineCapabilities([{
  routine: compileRoutineDefinition(bookDemoRoutine),
  trigger: { description: bookDemoRoutine.activation.triggerDescription, priority: bookDemoRoutine.activation.priority },
}]);

const agentWith = (overrides: Partial<AgentRecord> = {}): AgentRecord => ({
  id: "agent-1",
  workspaceId: "workspace-1",
  name: "Acme Support",
  customInstruction: "",
  assistantDefaultLocale: null,
  chatModelOverride: null,
  retrievalEnabled: true,
  contactRequestsEnabled: false,
  contactRequestDelivery: { recipientEmails: [], webhook: null },
  webhookExportsEnabled: false,
  skillSettings: {},
  authoredDirectives: [orderLookupDirective],
  ...overrides,
}) as unknown as AgentRecord;

const sessionWith = (agent: AgentRecord = agentWith()) => ({
  agent,
  conversation: { id: "conversation-1", workspaceId: "workspace-1", agentRevisionId: "revision-1" },
  userMessage: { id: "message-1", content: "Can it take actions, or is it just a chatbot?" } as MessageRecord,
  history: [],
  previewRoutineIds: ["routine-draft-1"],
});

const completedState = (routineId: string) => ({ routineId }) as RoutineState;

const sourcesWith = (overrides: Partial<AgentCapabilitySources> = {}): AgentCapabilitySources => ({
  routineProvider: { describeStartable: vi.fn(async () => bookDemo) },
  routineStore: { loadCompleted: vi.fn(async () => [completedState("routine-done-1")]) },
  directiveRuntime: { grantedDirectives: vi.fn(async (_input, directives) => [...directives]) },
  logger: { warn: vi.fn() },
  ...overrides,
});

const read = (input: {
  sources?: AgentCapabilitySources;
  agent?: AgentRecord;
  availability?: DirectiveBindingAvailability;
} = {}) => agentCapabilitiesHandle(
  input.sources ?? sourcesWith(),
  sessionWith(input.agent),
  input.availability ?? availabilityWith(turnSkillState),
).read();

const directReplyPrompt = (isIdentityQuestion: boolean, capabilities: AgentCapabilities | null): string =>
  buildAssistantReplyPrompt({
    route: CHAT_TURN_ROUTE.DIRECT,
    responseIdentity: { name: "Acme Support" },
    answerInstructionBlock: "Configured response instructions:\nHelp Acme customers.",
    history: [],
    query: "Can it take actions, or is it just a chatbot?",
    framing: { isIdentityQuestion },
    ...(capabilities ? { capabilities } : {}),
  });

describe("a direct reply to what the agent can do (#1872)", () => {
  it("names what the conversation could start and when the agent's skills apply, but no internals and no skill handle", async () => {
    const prompt = directReplyPrompt(true, await read());

    expect(prompt).toContain(bookDemoRoutine.name);
    expect(prompt).toContain(bookDemoRoutine.activation.triggerDescription);
    expect(prompt).toContain("the visitor asks where their order is");
    expect(prompt).not.toContain("order_status");
    expect(prompt).not.toContain(orderLookupDirective.action);
    for (const step of bookDemoRoutine.steps) {
      expect(prompt).not.toContain(step.instruction);
    }
    for (const slot of bookDemoRoutine.slots) {
      expect(prompt).not.toContain(slot.description);
    }
  });

  it("asks the routine provider about this conversation: its release, its turn, and what it already completed", async () => {
    const sources = sourcesWith();

    await read({ sources, agent: agentWith({ contactRequestsEnabled: true }) });

    expect(sources.routineProvider?.describeStartable).toHaveBeenCalledWith({
      agentId: "agent-1",
      agentRevisionId: "revision-1",
      workspaceId: "workspace-1",
      previewRoutineIds: ["routine-draft-1"],
      turn: expect.objectContaining({
        sessionId: "conversation-1",
        agent: expect.objectContaining({ metadata: expect.objectContaining({ contactRequestsEnabled: true }) }),
      }),
      completedRoutineIds: ["routine-done-1"],
    });
  });

  it("lists no routine on a turn that runs none", async () => {
    await expect(read({ sources: sourcesWith({ routineProvider: undefined }) })).resolves.toMatchObject({ routines: [] });
    await expect(read({ sources: sourcesWith({ routineStore: undefined }) })).resolves.toMatchObject({ routines: [] });
  });

  it.each([
    ["is no longer registered", null],
    ["is switched off", { ...turnSkillState, enabled: false }],
    ["cannot claim a turn", { ...turnSkillState, turnCapable: false }],
    ["needs a capability the plan denies", { ...turnSkillState, capabilityDenied: true }],
  ] as const)("lists no skill that %s", async (_reason, state) => {
    await expect(read({ availability: availabilityWith(state) })).resolves.toMatchObject({ skills: [] });
  });

  it("lists a skill the answer loop runs as a staged tool", async () => {
    const staged = { enabled: true, turnCapable: false, stagingCapable: true };

    await expect(read({ availability: availabilityWith(staged) }))
      .resolves.toMatchObject({ skills: [{ usedWhen: "the visitor asks where their order is" }] });
  });

  it.each([
    ["is switched off", { enabled: false }],
    ["is scoped away from the answer", { surfaces: ["suggested_questions" as const] }],
    ["applies on every turn, with no condition a visitor reads", {
      condition: { kind: "always" as const },
      description: "Internal: route order questions to the order desk.",
    }],
  ])("lists no skill whose directive %s", async (_reason, directive) => {
    const agent = agentWith({ authoredDirectives: [{ ...orderLookupDirective, ...directive }] as AuthoredDirective[] });

    await expect(read({ agent })).resolves.toMatchObject({ skills: [] });
  });

  it("lists no skill whose directive the directive runtime does not grant, and none without a runtime", async () => {
    const grantedDirectives = vi.fn(async () => []);

    await expect(read({ sources: sourcesWith({ directiveRuntime: { grantedDirectives } }) }))
      .resolves.toMatchObject({ skills: [] });
    expect(grantedDirectives).toHaveBeenCalledWith(
      { workspaceId: "workspace-1" },
      [expect.objectContaining({ name: orderLookupDirective.name })],
    );
    await expect(read({ sources: sourcesWith({ directiveRuntime: undefined }) }))
      .resolves.toMatchObject({ skills: [] });
  });

  it("keeps the list short: eight entries a kind, each cut to a sentence's length", async () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ name: `Task ${index}`, trigger: `${"The visitor wants it done. ".repeat(20)}${index}` }));

    const capabilities = await read({ sources: sourcesWith({ routineProvider: { describeStartable: vi.fn(async () => many) } }) });

    expect(capabilities?.routines).toHaveLength(8);
    for (const routine of capabilities?.routines ?? []) {
      expect(routine.trigger.length).toBeLessThanOrEqual(160);
    }
  });

  it("reads nothing until the reply asks, and then once", async () => {
    const sources = sourcesWith();
    const handle = agentCapabilitiesHandle(sources, sessionWith(), availabilityWith(turnSkillState));

    expect(sources.routineProvider?.describeStartable).not.toHaveBeenCalled();
    await handle.read();
    await handle.read();
    expect(sources.routineProvider?.describeStartable).toHaveBeenCalledTimes(1);
  });

  it("gives the reply no capabilities when the routines cannot be read, so it states no limit", async () => {
    const warn = vi.fn();
    const sources = sourcesWith({
      routineProvider: { describeStartable: vi.fn(async () => { throw new Error("database unavailable"); }) },
      logger: { warn },
    });

    await expect(read({ sources })).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "agent_capabilities_unavailable", conversationId: "conversation-1" }),
      expect.any(String),
    );
    expect(directReplyPrompt(true, null)).not.toContain("What You Can Do:");
  });

  it("leaves the capabilities out of a direct reply that does not ask about the assistant", async () => {
    const prompt = directReplyPrompt(false, await read());

    expect(prompt).not.toContain(bookDemoRoutine.name);
    expect(prompt).not.toContain("the visitor asks where their order is");
  });
});
