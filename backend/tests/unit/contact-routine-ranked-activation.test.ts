import { describe, expect, it, vi } from "vitest";

import type { ConversationModelGateway, Routine, TurnContext } from "@radioso/conversation-contract";
import { RoutineRegistry, type RoutineRegistration } from "@radioso/conversation-defaults";

import { compileRoutineDefinition } from "../../src/modules/routines/public.js";
import { contactRoutineDefinition } from "../../src/modules/chat/services/routines/contactRoutine.js";

const contactRoutine = compileRoutineDefinition(contactRoutineDefinition);

const turn = (content: string): TurnContext => ({
  agent: { id: "agent_1", name: "Support" },
  sessionId: "conv_1",
  inputEvent: { id: "msg_1", kind: "message", content },
  history: [{ role: "assistant", content: "How can I help?" }],
  stagedContext: [],
  steering: [],
});

const gatewayReturning = (text: string): ConversationModelGateway & { complete: ReturnType<typeof vi.fn> } => ({
  complete: vi.fn(async () => ({ text })),
});

const registration = (routine: Routine, description: string, priority = 0): RoutineRegistration => ({
  routine,
  trigger: { description, priority },
});

describe("contact routine ranked activation", () => {
  it("activates the contact routine when the ranked matcher scores contact intent above the floor", async () => {
    const gateway = gatewayReturning(JSON.stringify({
      matches: [{ routineId: contactRoutine.id, confidence: 0.91 }],
    }));
    const registry = new RoutineRegistry([
      registration(contactRoutine, contactRoutineDefinition.activation.triggerDescription, contactRoutineDefinition.activation.priority),
    ], { policy: { floor: 0.4, margin: 0.15, maxOptions: 4 } });

    await expect(registry.activator(gateway).activate({ turn: turn("I would like to contact a human.") }))
      .resolves.toEqual({ kind: "activate", routineId: contactRoutine.id, variables: undefined });
    expect(gateway.complete).toHaveBeenCalledTimes(1);
    expect(gateway.complete.mock.calls[0]![0].systemPrompt).toContain("The user asks a human to follow up with them.");
  });

  it("declines contact activation when the ranked matcher scores contact intent below the floor", async () => {
    const gateway = gatewayReturning(JSON.stringify({
      matches: [{ routineId: contactRoutine.id, confidence: 0.12 }],
    }));
    const registry = new RoutineRegistry([
      registration(contactRoutine, contactRoutineDefinition.activation.triggerDescription, contactRoutineDefinition.activation.priority),
    ], { policy: { floor: 0.4, margin: 0.15, maxOptions: 4 } });

    await expect(registry.activator(gateway).activate({ turn: turn("what is your email?") }))
      .resolves.toBeNull();
  });
});
