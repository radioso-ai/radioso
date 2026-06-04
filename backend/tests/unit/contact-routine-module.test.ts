import { describe, expect, it } from "vitest";
import type { ConversationModelGateway, TurnContext } from "@radioso/conversation-contract";

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

const gatewayReturning = (text: string): ConversationModelGateway => ({ complete: async () => ({ text }) });
const failingGateway: ConversationModelGateway = {
  complete: async () => {
    throw new Error("model gateway should not be called");
  },
};

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

    expect(registry.routineRegistrations.map((r) => r.routine.id)).toEqual([contactRoutine.id]);
    expect(registry.actionHandlerRegistrations.map((r) => r.type)).toEqual([CONTACT_SEND_ACTION_TYPE]);
    expect(registry.publicChatActionAdvertiserRegistrations).toHaveLength(1);
  });

  it("activates on the explicit contact pill click (fast path, no LLM call)", async () => {
    const { activates } = applyModule().routineRegistrations[0]!;

    // Enabled agent + the contact intent → activate without touching the model.
    expect(await activates({ turn: turnWith(intentClick, true), modelGateway: failingGateway })).toEqual({});
    // Same intent, but the agent has contact requests disabled → no activation, no LLM.
    expect(await activates({ turn: turnWith(intentClick, false), modelGateway: failingGateway })).toBeNull();
  });

  it("activates on a typed message only when the model judges contact intent, and only for enabled agents", async () => {
    const { activates } = applyModule().routineRegistrations[0]!;
    const typed = { method: "typed" };

    expect(
      await activates({ turn: turnWith(typed, true), modelGateway: gatewayReturning('{"wantsContact": true}') }),
    ).toEqual({});
    expect(
      await activates({ turn: turnWith(typed, true), modelGateway: gatewayReturning('{"wantsContact": false}') }),
    ).toBeNull();
    // Disabled agent → declines without calling the model.
    expect(await activates({ turn: turnWith(typed, false), modelGateway: failingGateway })).toBeNull();
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
});
