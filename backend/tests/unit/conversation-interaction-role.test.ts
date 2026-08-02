import { describe, expect, it } from "vitest";

import {
  buildTurnPlanResponseFormat,
  buildTurnPlanningPrompt,
  parseTurnPlan,
} from "../../src/modules/chat/services/turnPlanService.js";
import {
  buildTurnInterpretationPrompt,
  parseTurnInterpretation,
} from "../../src/modules/chat/services/conversationTurnInterpreter.js";
import { normalizeConversationInteractionMetadata } from "../../src/shared/domain/conversationInteractionMetadata.js";

const interactionRoles = [
  "substantive_new",
  "substantive_followup",
  "clarification_value",
  "control",
  "social",
  "unresolved",
] as const;

const stagedOutput = (interactionRole: unknown) => JSON.stringify({
  route: "direct",
  isIdentityQuestion: false,
  intentTopic: null,
  inScopeRequest: null,
  outsideScopeRequest: null,
  rewrite: null,
  interactionRole,
});

const fusedOutput = (interactionRole: unknown) => JSON.stringify({
  route: "direct",
  isIdentityQuestion: false,
  intentTopic: null,
  inScopeRequest: null,
  outsideScopeRequest: null,
  rewrite: null,
  interactionRole,
  responseLanguage: "English",
});

const noCandidates = {
  routineIds: new Set<string>(),
  directiveNames: new Set<string>(),
};

describe("ConversationInteractionRole", () => {
  it.each(interactionRoles)("strictly parses %s on both turn-understanding paths", (role) => {
    expect(parseTurnInterpretation(stagedOutput(role)).interactionRole).toBe(role);
    expect(parseTurnPlan(fusedOutput(role), noCandidates)?.interactionRole).toBe(role);
  });

  it.each([undefined, null, "acknowledgement", "SUBSTANTIVE_NEW", 1, {}, []])(
    "maps an unusable role (%j) to unresolved without discarding valid routing",
    (role) => {
      const staged = role === undefined
        ? JSON.stringify(JSON.parse(stagedOutput("unresolved"), (key, value) => key === "interactionRole" ? undefined : value))
        : stagedOutput(role);
      const fused = role === undefined
        ? JSON.stringify(JSON.parse(fusedOutput("unresolved"), (key, value) => key === "interactionRole" ? undefined : value))
        : fusedOutput(role);

      expect(parseTurnInterpretation(staged)).toMatchObject({
        route: "direct",
        interactionRole: "unresolved",
      });
      expect(parseTurnPlan(fused, noCandidates)).toMatchObject({
        route: "direct",
        interactionRole: "unresolved",
      });
    },
  );

  it("locks the fused provider schema to the exact required enum", () => {
    const format = buildTurnPlanResponseFormat({ routineIds: [], directiveNames: [] });
    const properties = format.schema.properties as Record<string, Record<string, unknown>>;

    expect(format.schema.required).toContain("interactionRole");
    expect(properties.interactionRole).toEqual({ type: "string", enum: interactionRoles });
  });

  it("teaches both prompts the same multilingual role contract", () => {
    const fused = buildTurnPlanningPrompt({
      query: "And what does that cost?",
      history: [],
      routineCandidates: [],
      directiveCandidates: [],
    });
    const staged = buildTurnInterpretationPrompt({
      context: "",
      query: "And what does that cost?",
    });

    for (const role of interactionRoles) {
      expect(fused).toContain(role);
      expect(staged).toContain(role);
    }
    expect(fused).toContain("Do not rely on English keyword matching");
    expect(staged).toContain("Do not rely on English keyword matching");
  });

  it("persists only bounded round-trippable semantic intents and downgrades an empty substantive role", () => {
    expect(normalizeConversationInteractionMetadata({
      role: "substantive_followup",
      semanticIntents: [
        { id: "primary", text: "A contextual intent" },
        { id: "invalid id", text: "Cannot be loaded by identifier" },
        { id: "oversized", text: "x".repeat(4_001) },
        { id: "duplicate_text", text: "A contextual intent" },
      ],
    })).toEqual({
      role: "substantive_followup",
      semanticIntents: [{ id: "primary", text: "A contextual intent" }],
    });

    expect(normalizeConversationInteractionMetadata({
      role: "substantive_new",
      semanticIntents: [{ id: "invalid id", text: "Discard me" }],
    })).toEqual({ role: "unresolved", semanticIntents: [] });
  });
});
