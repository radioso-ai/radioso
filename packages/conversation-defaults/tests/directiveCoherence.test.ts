import { describe, expect, it, vi } from "vitest";

import type { ConversationModelGateway, Directive } from "@radioso/conversation-contract";

import {
  createDirectiveCoherenceChecker,
  DirectiveCoherenceError,
} from "../src/index.js";

const directive = (overrides: Partial<Directive> & Pick<Directive, "name" | "action">): Directive => ({
  id: overrides.id,
  name: overrides.name,
  condition: overrides.condition ?? { kind: "always" },
  action: overrides.action,
  priority: overrides.priority,
  requiredCapabilities: overrides.requiredCapabilities,
  dependsOn: overrides.dependsOn,
  excludes: overrides.excludes,
  description: overrides.description,
  metadata: overrides.metadata,
  surfaces: overrides.surfaces,
});

describe("directive coherence", () => {
  it("returns a structured conflict verdict from the model-backed checker", async () => {
    const gateway: ConversationModelGateway = {
      complete: vi.fn(async () => ({
        text: JSON.stringify({
          verdict: "conflict",
          conflicts: [{
            directiveId: "directive_formal",
            directiveName: "formal-greeting",
            reason: "The candidate forbids the greeting behavior that the existing directive requires.",
          }],
          rationale: "The two directives cannot both be followed on the same turns.",
        }),
      })),
    };
    const checker = createDirectiveCoherenceChecker({ modelGateway: gateway });

    const verdict = await checker.check({
      agent: { id: "agent_support", name: "Support" },
      candidate: directive({
        id: "directive_terse",
        name: "terse-no-greeting",
        action: "Never greet; be terse.",
      }),
      existingDirectives: [directive({
        id: "directive_formal",
        name: "formal-greeting",
        action: "Always greet formally.",
      })],
    });

    expect(verdict).toEqual({
      coherent: false,
      conflicts: [{
        directiveId: "directive_formal",
        directiveName: "formal-greeting",
        reason: "The candidate forbids the greeting behavior that the existing directive requires.",
      }],
      rationale: "The two directives cannot both be followed on the same turns.",
    });
    expect(gateway.complete).toHaveBeenCalledOnce();
  });

  it("exposes a concrete error type for structured conflict handling", () => {
    const error = new DirectiveCoherenceError({
      coherent: false,
      conflicts: [{ directiveName: "existing", reason: "Conflict." }],
      rationale: "Blocked.",
    });

    expect(error.message).toBe("conversation_kit_directive_coherence_conflict");
    expect(error.code).toBe("conversation_kit_directive_coherence_conflict");
  });

  it("includes directive surfaces in the model payload", async () => {
    const complete = vi.fn(async () => ({
      text: JSON.stringify({
        verdict: "coherent",
        conflicts: [],
        rationale: "The directives can be followed together.",
      }),
    }));
    const checker = createDirectiveCoherenceChecker({ modelGateway: { complete } });

    await checker.check({
      agent: { id: "agent_support", name: "Support" },
      candidate: directive({
        name: "candidate",
        action: "Do not suggest questions about pricing.",
      }),
      existingDirectives: [directive({
        name: "existing",
        action: "Answer concisely and suggest a relevant follow-up.",
        surfaces: ["answer", "suggested_questions"],
      })],
    });

    const request = complete.mock.calls[0]?.[0];
    const payload = JSON.parse(request?.messages[0]?.content ?? "null") as {
      candidate?: { surfaces?: string[] };
      existingDirectives?: Array<{ surfaces?: string[] }>;
    };
    expect(payload.candidate?.surfaces).toEqual(["answer"]);
    expect(payload.existingDirectives?.[0]?.surfaces).toEqual(["answer", "suggested_questions"]);
  });

  it("fails open when the model does not return a structured verdict", async () => {
    const gateway: ConversationModelGateway = {
      complete: vi.fn(async () => ({ text: "not json" })),
    };
    const checker = createDirectiveCoherenceChecker({ modelGateway: gateway });

    const verdict = await checker.check({
      agent: { id: "agent_support", name: "Support" },
      candidate: directive({
        name: "candidate",
        action: "Use operator behavior.",
      }),
      existingDirectives: [directive({
        name: "existing",
        action: "Use existing behavior.",
      })],
    });

    expect(verdict).toEqual({
      coherent: true,
      conflicts: [],
      rationale: "Coherence check unavailable.",
    });
  });
});
