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

const turnWith = (metadata: Record<string, unknown> | undefined): TurnContext => ({
  agent: { id: "a", name: "A" },
  sessionId: "conv_1",
  inputEvent: { kind: "message", content: "contact", metadata },
  history: [],
  stagedContext: [],
  steering: [],
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

  it("activates the routine only on the explicit contact intent_click", async () => {
    const { activates } = applyModule().routineRegistrations[0]!;

    expect(
      await activates({ turn: turnWith({ method: "intent_click", intent: { skillName: CONTACT_INTENT_SKILL_NAME } }) }),
    ).toEqual({});
    expect(
      await activates({ turn: turnWith({ method: "intent_click", intent: { skillName: "something.else" } }) }),
    ).toBeNull();
    expect(await activates({ turn: turnWith({ method: "suggestion_click" }) })).toBeNull();
    expect(await activates({ turn: turnWith(undefined) })).toBeNull();
  });

  it("advertises the contact action (surfacing the button) without claiming the turn", async () => {
    const registration = applyModule().chatIntakeProviderRegistrations[0]!;
    const provider = typeof registration === "function" ? registration({} as never) : registration;

    expect(await provider.getPublicIntakeActions?.({ workspaceId: "ws_1" })).toEqual([
      { skillName: CONTACT_INTENT_SKILL_NAME, intentName: CONTACT_INTENT_NAME },
    ]);
    // handle returns null → the turn falls through to the engine, where the routine runs.
    expect(
      await provider.handle({
        workspaceId: "ws_1",
        conversationId: "c",
        userMessageId: "m",
        query: "contact",
        history: [],
      }),
    ).toBeNull();
  });
});
