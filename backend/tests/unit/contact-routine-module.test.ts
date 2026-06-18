import { describe, expect, it } from "vitest";
import {
  ApplicationModuleCoordinator,
  createApplicationExtensionRegistry,
} from "../../src/app/composition/applicationModule.js";
import { createContactRoutineApplicationModule } from "../../src/app/composition/builtIn/contactRoutineModule.js";
import {
  contactRoutineDefinition,
  CONTACT_SEND_ACTION_TYPE,
  HANDOFF_NOTIFY_ACTION_TYPE,
  CONTACT_INTENT_SKILL_NAME,
  CONTACT_INTENT_NAME,
} from "../../src/modules/chat/services/routines/contactRoutine.js";
import { compileRoutineDefinition } from "../../src/modules/routines/public.js";
import { capabilityNames } from "../../src/shared/domain/capabilityPolicy.js";

const agentServiceWith = (contactRequestsEnabled: boolean) => ({
  resolve: async () => ({ contactRequestsEnabled }),
});

const applyModule = () => {
  const registry = createApplicationExtensionRegistry();
  new ApplicationModuleCoordinator({
    logger: { error: () => {} },
    registry,
  }).apply([createContactRoutineApplicationModule()]);
  return registry;
};

describe("contact routine application module", () => {
  it("registers the contact routine, the contact.send handler, and the public action advertiser", () => {
    const registry = applyModule();

    expect(registry.routineRegistrations.map((r) => r.routine.id)).toEqual([
      compileRoutineDefinition(contactRoutineDefinition).id,
    ]);
    expect(registry.routineRegistrations[0]?.trigger).toEqual({
      description: contactRoutineDefinition.activation.triggerDescription,
      priority: contactRoutineDefinition.activation.priority,
      gateRef: contactRoutineDefinition.activation.gateRef,
      eligible: expect.any(Function),
      explicitClaim: expect.any(Function),
    });
    expect(registry.actionHandlerRegistrations.map((r) => r.type)).toEqual([
      CONTACT_SEND_ACTION_TYPE,
      HANDOFF_NOTIFY_ACTION_TYPE,
    ]);
    expect(registry.actionHandlerRegistrations[0]?.requiredCapabilities).toEqual([
      capabilityNames.humanContact.request,
    ]);
    expect(registry.actionHandlerRegistrations[1]?.requiredCapabilities).toEqual([
      capabilityNames.humanContact.request,
    ]);
    expect(registry.publicChatActionAdvertiserRegistrations).toHaveLength(1);
  });

  it("advertises the contact action only when the agent enabled it", async () => {
    const registration = applyModule().publicChatActionAdvertiserRegistrations[0]!;
    const build = (enabled: boolean) =>
      typeof registration === "function"
        ? registration({ agentService: agentServiceWith(enabled) } as never)
        : registration;

    expect(await build(true).getPublicIntakeActions?.({ workspaceId: "ws_1", agentId: "a" })).toEqual([
      { skillName: CONTACT_INTENT_SKILL_NAME, intentName: CONTACT_INTENT_NAME },
    ]);
    expect(await build(false).getPublicIntakeActions?.({ workspaceId: "ws_1", agentId: "a" })).toEqual([]);
    expect("handle" in build(true)).toBe(false);
  });

  it("keeps contact activation behind the agent flag and claims intent-click metadata deterministically", () => {
    const registration = applyModule().routineRegistrations[0]!;
    const baseTurn = {
      agent: { id: "agent_1", metadata: { contactRequestsEnabled: true } },
      sessionId: "conv_1",
      inputEvent: { kind: "message" as const, content: "ignored" },
      history: [],
      stagedContext: [],
      steering: [],
    };

    expect(registration.trigger.eligible?.({ turn: {
      ...baseTurn,
      agent: { id: "agent_1", metadata: { contactRequestsEnabled: false } },
    } })).toBe(false);
    expect(registration.trigger.eligible?.({ turn: baseTurn })).toBe(true);
    expect(registration.trigger.explicitClaim?.({ turn: {
      ...baseTurn,
      inputEvent: {
        kind: "message" as const,
        content: "",
        metadata: {
          method: "intent_click",
          intent: { skillName: CONTACT_INTENT_SKILL_NAME },
        },
      },
    } })).toEqual({});
    expect(registration.trigger.explicitClaim?.({ turn: {
      ...baseTurn,
      inputEvent: {
        kind: "message" as const,
        content: "contact a human",
        metadata: { method: "message" },
      },
    } })).toBeNull();
  });
});
