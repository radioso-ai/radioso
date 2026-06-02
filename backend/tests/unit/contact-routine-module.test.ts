import { describe, expect, it } from "vitest";
import type { TurnContext } from "@radioso/conversation-contract";

import {
  ApplicationModuleCoordinator,
  createApplicationExtensionRegistry,
} from "../../src/app/composition/applicationModule.js";
import { createContactRoutineApplicationModule } from "../../src/app/composition/builtIn/contactRoutineModule.js";
import {
  contactRoutine,
  CONTACT_SEND_ACTION_TYPE,
  CONTACT_INTENT_SKILL_NAME,
  CONTACT_INTENT_NAME,
} from "../../src/modules/chat/services/routines/contactRoutine.js";

const turnWith = (
  metadata: Record<string, unknown> | undefined,
  contactRequestsEnabled = true,
): TurnContext => ({
  agent: { id: "a", name: "A", metadata: { contactRequestsEnabled } },
  sessionId: "conv_1",
  inputEvent: { kind: "message", content: "contact", metadata },
  history: [],
  stagedContext: [],
  steering: [],
});

const intentClick = { method: "intent_click", intent: { skillName: CONTACT_INTENT_SKILL_NAME } };

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
  it("registers the contact routine, the contact.send handler, and the intake advertiser", () => {
    const registry = applyModule();

    expect(registry.routineRegistrations.map((r) => r.routine.id)).toEqual([contactRoutine.id]);
    expect(registry.actionHandlerRegistrations.map((r) => r.type)).toEqual([CONTACT_SEND_ACTION_TYPE]);
    expect(registry.chatIntakeProviderRegistrations).toHaveLength(1);
  });

  it("activates the routine on the contact intent_click only when the agent enabled it", async () => {
    const { activates } = applyModule().routineRegistrations[0]!;

    expect(await activates({ turn: turnWith(intentClick, true) })).toEqual({});
    // Same intent, but the agent has contact requests disabled → no activation.
    expect(await activates({ turn: turnWith(intentClick, false) })).toBeNull();
    // Enabled agent, but not the contact intent → no activation.
    expect(
      await activates({ turn: turnWith({ method: "intent_click", intent: { skillName: "something.else" } }, true) }),
    ).toBeNull();
    expect(await activates({ turn: turnWith({ method: "suggestion_click" }, true) })).toBeNull();
    expect(await activates({ turn: turnWith(undefined, true) })).toBeNull();
  });

  it("advertises the contact action only when the agent enabled it, and never claims the turn", async () => {
    const registration = applyModule().chatIntakeProviderRegistrations[0]!;
    const build = (enabled: boolean) =>
      typeof registration === "function"
        ? registration({ agentService: agentServiceWith(enabled) } as never)
        : registration;

    expect(await build(true).getPublicIntakeActions?.({ workspaceId: "ws_1", agentId: "a" })).toEqual([
      { skillName: CONTACT_INTENT_SKILL_NAME, intentName: CONTACT_INTENT_NAME },
    ]);
    expect(await build(false).getPublicIntakeActions?.({ workspaceId: "ws_1", agentId: "a" })).toEqual([]);
    // handle returns null → the turn falls through to the engine, where the routine runs.
    expect(
      await build(true).handle({
        workspaceId: "ws_1",
        conversationId: "c",
        userMessageId: "m",
        query: "contact",
        history: [],
      }),
    ).toBeNull();
  });
});
