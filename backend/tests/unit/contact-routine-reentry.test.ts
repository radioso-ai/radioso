import { describe, expect, it } from "vitest";
import { RoutineRegistry } from "@radioso/conversation-defaults";
import type { TurnContext } from "@radioso/conversation-contract";

import {
  ApplicationModuleCoordinator,
  createApplicationExtensionRegistry,
} from "../../src/app/composition/applicationModule.js";
import { createContactRoutineApplicationModule } from "../../src/app/composition/builtIn/contactRoutineModule.js";
import {
  contactRoutineDefinition,
  CONTACT_INTENT_SKILL_NAME,
} from "../../src/modules/chat/services/routines/contactRoutine.js";
import { compileRoutineDefinition } from "../../src/modules/routines/public.js";

/**
 * Characterization of the in-code routine registration path. `contactRoutineModule` is the
 * only production registration built by hand rather than compiled from a stored definition,
 * so it is where an authored activation policy can be dropped on the way to the registry.
 */

const contactRoutineId = compileRoutineDefinition(contactRoutineDefinition).id;

const policy = { floor: 0.4, margin: 0.15, maxOptions: 4 };

const registrationFromModule = () => {
  const registry = createApplicationExtensionRegistry();
  new ApplicationModuleCoordinator({ logger: { error: () => {} }, registry }).apply([
    createContactRoutineApplicationModule(),
  ]);
  const registration = registry.routineRegistrations[0];
  if (!registration) {
    throw new Error("contact routine module registered no routine");
  }
  return registration;
};

const turn: TurnContext = {
  agent: {
    id: "agent_1",
    name: "Assistant",
    metadata: { contactRequestsEnabled: true, hasContactDestination: true },
  },
  sessionId: "session_1",
  inputEvent: { id: "input_1", kind: "message", content: "can someone call me back?" },
  history: [],
  stagedContext: [],
  steering: [],
};

const intentClickTurn: TurnContext = {
  ...turn,
  inputEvent: {
    ...turn.inputEvent,
    metadata: { method: "intent_click", intent: { skillName: CONTACT_INTENT_SKILL_NAME } },
  },
};

describe("in-code contact routine activation policy", () => {
  it("authors `always` reentry so a visitor can reach a human more than once", () => {
    expect(contactRoutineDefinition.activation.reentryMode).toBe("always");
  });

  it("carries the authored reentry mode onto the compiled routine the registry reads", () => {
    // The hand-built registration declares no reentry policy of its own, so this is the
    // only copy: there is nothing for this path to forget to populate.
    expect(registrationFromModule().routine.activation?.reentryMode).toBe("always");
  });

  it("keeps the routine eligible for ranked activation after a completed instance", async () => {
    const prepared = await new RoutineRegistry([registrationFromModule()], { policy })
      .prepareCandidates(turn, { suppressedRoutineIds: [contactRoutineId] });

    expect(prepared.kind).toBe("rank");
    if (prepared.kind !== "rank") {
      return;
    }
    expect(prepared.registrations.map((registration) => registration.routine.id)).toEqual([
      contactRoutineId,
    ]);
  });

  it("lets the contact intake button claim a turn after a completed instance", async () => {
    // `explicitClaim` is only consulted for registrations that survived reentry
    // suppression, so suppression would disable the button, not just ranked activation.
    const prepared = await new RoutineRegistry([registrationFromModule()], { policy })
      .prepareCandidates(intentClickTurn, { suppressedRoutineIds: [contactRoutineId] });

    expect(prepared).toMatchObject({
      kind: "claim",
      activation: { kind: "activate", routineId: contactRoutineId },
    });
  });

  it("still suppresses a completed routine that authors the default reentry mode", async () => {
    // Guards against reading `always` too broadly: only the authored mode un-suppresses.
    const registration = registrationFromModule();
    const defaulted = {
      ...registration,
      routine: {
        ...registration.routine,
        activation: { ...registration.routine.activation!, reentryMode: "once_per_conversation" as const },
      },
    };

    const prepared = await new RoutineRegistry([defaulted], { policy })
      .prepareCandidates(turn, { suppressedRoutineIds: [contactRoutineId] });

    expect(prepared).toEqual({ kind: "none" });
  });

  it("offers the routine when nothing has completed yet", async () => {
    const prepared = await new RoutineRegistry([registrationFromModule()], { policy })
      .prepareCandidates(turn);

    expect(prepared.kind).toBe("rank");
  });

  it("lets the contact button claim a turn when nothing has completed yet", async () => {
    const prepared = await new RoutineRegistry([registrationFromModule()], { policy })
      .prepareCandidates(intentClickTurn);

    expect(prepared).toMatchObject({
      kind: "claim",
      activation: { kind: "activate", routineId: contactRoutineId },
    });
  });

  it("suppresses the routine when the agent is not eligible for contact requests", async () => {
    const prepared = await new RoutineRegistry([registrationFromModule()], { policy })
      .prepareCandidates({
        ...turn,
        agent: { ...turn.agent, metadata: { contactRequestsEnabled: false, hasContactDestination: true } },
      });

    expect(prepared).toEqual({ kind: "none" });
  });
});
