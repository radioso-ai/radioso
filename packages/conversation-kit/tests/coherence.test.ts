import { describe, expect, it, vi } from "vitest";

import type { ConversationModelGateway, Directive } from "@radioso/conversation-contract";

import {
  createConversationKitClient,
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
});

describe("directive coherence", () => {
  it("blocks SDK directive creation when the gate finds a seeded contradiction", async () => {
    const gateway: ConversationModelGateway = {
      complete: vi.fn(async () => ({
        text: JSON.stringify({
          verdict: "conflict",
          conflicts: [{
            directiveId: "directive_formal",
            directiveName: "formal-greeting",
            reason: "The candidate forbids the greeting behavior that the existing directive requires.",
          }],
          rationale: "The candidate contradicts an active greeting directive.",
        }),
      })),
    };
    const client = createConversationKitClient({
      modelGateway: gateway,
      directiveCoherence: { enabled: true },
    });
    const agent = client.createAgent({ id: "agent_support", name: "Support" });
    await client.createDirective(agent.id, directive({
      id: "directive_formal",
      name: "formal-greeting",
      action: "Always greet formally.",
    }));

    await expect(client.createDirective(agent.id, directive({
      id: "directive_terse",
      name: "terse-no-greeting",
      action: "Never greet; be terse.",
    }))).rejects.toMatchObject({
      code: "conversation_kit_directive_coherence_conflict",
      verdict: {
        coherent: false,
        conflicts: [{
          directiveId: "directive_formal",
          directiveName: "formal-greeting",
        }],
      },
    });
    expect(client.getDirective(agent.id, "directive_terse")).toBeNull();
  });

  it("allows SDK directive creation when the checker returns a compatible verdict", async () => {
    const gateway: ConversationModelGateway = {
      complete: vi.fn(async () => ({
        text: JSON.stringify({
          verdict: "coherent",
          conflicts: [],
          rationale: "The candidate adds formatting guidance without changing greeting behavior.",
        }),
      })),
    };
    const client = createConversationKitClient({
      modelGateway: gateway,
      directiveCoherence: { enabled: true },
    });
    const agent = client.createAgent({ id: "agent_docs", name: "Docs" });
    await client.createDirective(agent.id, directive({
      id: "directive_markdown",
      name: "markdown",
      action: "Use Markdown lists for multi-step explanations.",
    }));

    const created = await client.createDirective(agent.id, directive({
      id: "directive_citations",
      name: "citations",
      action: "Include citations when supplied by retrieval context.",
    }));

    expect(created).toMatchObject({ id: "directive_citations", name: "citations" });
    expect(client.getDirective(agent.id, "directive_citations")).toMatchObject({
      action: "Include citations when supplied by retrieval context.",
    });
  });

  it("blocks SDK directive updates that would introduce a contradiction", async () => {
    const gateway: ConversationModelGateway = {
      complete: vi
        .fn()
        .mockResolvedValueOnce({
          text: JSON.stringify({
            verdict: "coherent",
            conflicts: [],
            rationale: "The initial directives can coexist.",
          }),
        })
        .mockResolvedValueOnce({
          text: JSON.stringify({
            verdict: "conflict",
            conflicts: [{
              directiveId: "directive_formal",
              directiveName: "formal-greeting",
              reason: "The update forbids the greeting behavior that the existing directive requires.",
            }],
            rationale: "The updated directive contradicts an active greeting directive.",
          }),
        }),
    };
    const client = createConversationKitClient({
      modelGateway: gateway,
      directiveCoherence: { enabled: true },
    });
    const agent = client.createAgent({ id: "agent_update", name: "Update Agent" });
    await client.createDirective(agent.id, directive({
      id: "directive_formal",
      name: "formal-greeting",
      action: "Always greet formally.",
    }));
    await client.createDirective(agent.id, directive({
      id: "directive_tone",
      name: "tone",
      action: "Use a concise but polite tone.",
    }));

    await expect(client.updateDirective(agent.id, "directive_tone", {
      action: "Never greet; be terse.",
    })).rejects.toMatchObject({
      code: "conversation_kit_directive_coherence_conflict",
      verdict: {
        coherent: false,
        conflicts: [{ directiveId: "directive_formal" }],
      },
    });
    expect(client.getDirective(agent.id, "directive_tone")?.action).toBe("Use a concise but polite tone.");
  });

  it("preserves Phase F authoring behavior when no coherence gate is configured", () => {
    const gateway: ConversationModelGateway = {
      complete: vi.fn(async () => ({ text: "unused" })),
    };
    const client = createConversationKitClient({ modelGateway: gateway });
    const agent = client.createAgent({ id: "agent_plain", name: "Plain" });

    const created = client.createDirective(agent.id, directive({
      id: "directive_plain",
      name: "plain",
      action: "Answer plainly.",
    }));

    expect(created).toMatchObject({ id: "directive_plain", name: "plain" });
    expect(gateway.complete).not.toHaveBeenCalled();
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
});
