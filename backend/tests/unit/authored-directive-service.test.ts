import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { AuthoredDirectiveService } from "../../src/modules/agents/public.js";
import type { AuthoredDirective, AuthoredDirectiveInput, AuthoredDirectiveServiceOptions } from "../../src/modules/agents/public.js";
import type { AgentSkillSpine } from "../../src/modules/agentSkills/public.js";
import { defaultAnswerDirectives } from "../../src/modules/directives/public.js";
import type { Directive } from "../../src/modules/directives/public.js";
import { AppError } from "../../src/shared/domain/errors.js";
import { InMemoryAgentRepository } from "../support/fakes.js";
import type { DirectiveCoherenceChecker, DirectiveCoherenceVerdict } from "@radioso/conversation-defaults";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";

const coherentVerdict: DirectiveCoherenceVerdict = {
  coherent: true,
  conflicts: [],
  rationale: "The candidate can be followed with the existing directives.",
};

const directiveInput = (overrides: Partial<AuthoredDirectiveInput> = {}): AuthoredDirectiveInput => ({
  name: `operator-directive-${randomUUID()}`,
  condition: { kind: "always" },
  action: "Use the operator configured behavior.",
  ...overrides,
});

const agentSkill = (overrides: Partial<AgentSkillSpine> & Pick<AgentSkillSpine, "skillName">): AgentSkillSpine => {
  const now = new Date("2026-06-05T12:00:00.000Z");
  return {
    id: randomUUID(),
    agentId,
    workspaceId,
    kind: "external_mcp",
    invocationMode: "agent_selectable",
    enabled: true,
    targetType: "mcp_connection",
    targetId: randomUUID(),
    config: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
};

const persistedDirective = (input: AuthoredDirectiveInput, overrides: Partial<AuthoredDirective> = {}): AuthoredDirective => {
  const now = new Date("2026-06-05T12:00:00.000Z");
  return {
    id: randomUUID(),
    agentId,
    name: input.name,
    condition: input.condition,
    action: input.action,
    priority: null,
    requiredCapabilities: input.requiredCapabilities ?? [],
    dependsOn: input.dependsOn ?? [],
    excludes: input.excludes ?? [],
    tags: input.tags ?? [],
    routes: [],
    surfaces: input.surfaces ?? [],
    description: input.description ?? null,
    binding: input.binding ?? null,
    lifecycle: null,
    enabled: input.enabled ?? true,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
};

type StubAgentRepositoryPort = AuthoredDirectiveServiceOptions["repository"];

class StubAgentRepository implements StubAgentRepositoryPort {
  readonly created: AuthoredDirectiveInput[] = [];
  readonly updated: Array<{ directiveId: string; input: Partial<AuthoredDirectiveInput> }> = [];
  readonly directives: AuthoredDirective[] = [];

  async findByIdAndWorkspaceId() {
    return {
      id: agentId,
      workspaceId,
      name: "Test agent",
      customInstruction: "Be useful.",
      greetingInstruction: "Hello",
      assistantDefaultLocale: null,
      chatModelOverride: null,
    };
  }

  async listDirectives(): Promise<AuthoredDirective[]> {
    return this.directives;
  }

  async createDirective(_agentId: string, _workspaceId: string, input: AuthoredDirectiveInput): Promise<AuthoredDirective> {
    this.created.push(input);
    const directive = persistedDirective(input);
    this.directives.push(directive);
    return directive;
  }

  async updateDirective(
    _agentId: string,
    _workspaceId: string,
    directiveId: string,
    input: Partial<AuthoredDirectiveInput>,
  ): Promise<AuthoredDirective> {
    this.updated.push({ directiveId, input });
    const existing = this.directives.find((directive) => directive.id === directiveId);
    const merged = persistedDirective({
      name: input.name ?? existing?.name ?? "updated-directive",
      condition: input.condition ?? existing?.condition ?? { kind: "always" },
      action: input.action ?? existing?.action ?? "Updated action",
      surfaces: input.surfaces ?? existing?.surfaces ?? [],
      requiredCapabilities: input.requiredCapabilities ?? existing?.requiredCapabilities ?? [],
      dependsOn: input.dependsOn ?? existing?.dependsOn ?? [],
      excludes: input.excludes ?? existing?.excludes ?? [],
      tags: input.tags ?? existing?.tags ?? [],
      binding: Object.prototype.hasOwnProperty.call(input, "binding") ? input.binding : existing?.binding ?? null,
      enabled: Object.prototype.hasOwnProperty.call(input, "enabled") ? input.enabled : existing?.enabled ?? true,
    });
    return { ...merged, id: directiveId };
  }

  // Mirrors the real repository's version-gated DELETE: a directiveId that no longer exists, or
  // whose updated_at no longer matches an expectedUpdatedAt the caller passed, deletes nothing.
  async deleteDirective(_agentId: string, _workspaceId: string, directiveId: string, options?: { expectedUpdatedAt?: Date }): Promise<boolean> {
    const existing = this.directives.find((directive) => directive.id === directiveId);
    if (!existing) {
      return false;
    }
    if (options?.expectedUpdatedAt && existing.updatedAt.getTime() !== options.expectedUpdatedAt.getTime()) {
      return false;
    }
    this.directives.splice(this.directives.indexOf(existing), 1);
    return true;
  }
}

class StubAgentSkillRepository {
  readonly skills: AgentSkillSpine[] = [];

  async findByName(_workspaceId: string, _agentId: string, skillName: string): Promise<AgentSkillSpine | null> {
    return this.skills.find((skill) => skill.skillName === skillName) ?? null;
  }
}

class CapturingChecker implements DirectiveCoherenceChecker {
  readonly checks: Array<{
    candidate: Directive;
    existingDirectives: Directive[];
    invocationContext?: unknown;
  }> = [];

  constructor(private readonly verdict: DirectiveCoherenceVerdict = coherentVerdict) {}

  async check(input: {
    candidate: Directive;
    existingDirectives: Directive[];
    invocationContext?: unknown;
  }): Promise<DirectiveCoherenceVerdict> {
    this.checks.push({
      candidate: input.candidate,
      existingDirectives: input.existingDirectives,
      invocationContext: input.invocationContext,
    });
    return this.verdict;
  }
}

describe("AuthoredDirectiveService", () => {
  it("normalizes directive skill bindings and defaults absent bindings to null", async () => {
    const repository = new StubAgentRepository();
    const agentSkills = new StubAgentSkillRepository();
    agentSkills.skills.push(agentSkill({ skillName: "order.lookup" }));
    const service = new AuthoredDirectiveService({
      repository,
      coherenceChecker: new CapturingChecker(),
      registeredCapabilityNames: new Set(),
      agentSkills,
    });

    await service.create(workspaceId, agentId, directiveInput({
      binding: { kind: "skill", skillName: " order.lookup " },
    }));
    expect(repository.created.at(-1)?.binding).toEqual({ kind: "skill", skillName: "order.lookup" });

    await service.create(workspaceId, agentId, directiveInput());
    expect(repository.created.at(-1)?.binding).toBeNull();
  });

  it("rejects unsupported directive binding targets and overlong skill names", async () => {
    const repository = new StubAgentRepository();
    const service = new AuthoredDirectiveService({
      repository,
      coherenceChecker: new CapturingChecker(),
      registeredCapabilityNames: new Set(),
    });

    await expect(service.create(workspaceId, agentId, directiveInput({
      binding: { kind: "routine", routineName: "returns" } as never,
    }))).rejects.toMatchObject({
      statusCode: 400,
      code: "bad_request",
    });

    await expect(service.create(workspaceId, agentId, directiveInput({
      binding: { kind: "skill", skillName: "x".repeat(201) },
    }))).rejects.toMatchObject({
      statusCode: 400,
      code: "bad_request",
    });

    expect(repository.created).toHaveLength(0);
  });

  it("persists a valid create and returns the coherence verdict", async () => {
    const repository = new StubAgentRepository();
    const checker = new CapturingChecker(coherentVerdict);
    const service = new AuthoredDirectiveService({
      repository,
      coherenceChecker: checker,
      registeredCapabilityNames: new Set(["retrieval.answer"]),
    });

    const result = await service.create(workspaceId, agentId, directiveInput());

    expect(repository.created).toHaveLength(1);
    expect(result.directive.name).toBe(repository.created[0]?.name);
    expect(result.coherence).toEqual(coherentVerdict);
  });

  it("passes real workspace and agent attribution into the coherence invocation", async () => {
    const repository = new StubAgentRepository();
    const checker = new CapturingChecker(coherentVerdict);
    const service = new AuthoredDirectiveService({
      repository,
      coherenceChecker: checker,
      registeredCapabilityNames: new Set(),
    });

    await service.create(workspaceId, agentId, directiveInput());

    expect(checker.checks[0]?.invocationContext).toEqual({ workspaceId, agentId });
  });

  it("preserves scope tags through validation, coherence, and persistence", async () => {
    const repository = new StubAgentRepository();
    const checker = new CapturingChecker(coherentVerdict);
    const service = new AuthoredDirectiveService({
      repository,
      coherenceChecker: checker,
      registeredCapabilityNames: new Set(),
    });

    const result = await service.create(workspaceId, agentId, directiveInput({
      tags: ["step:contact:ask_email", "step:contact:ask_email", "routine:contact"],
    }));

    expect(repository.created[0]?.tags).toEqual(["step:contact:ask_email", "routine:contact"]);
    expect(checker.checks[0]?.candidate.tags).toEqual(["step:contact:ask_email", "routine:contact"]);
    expect(result.directive.tags).toEqual(["step:contact:ask_email", "routine:contact"]);
  });

  it("rejects unknown required capabilities before persistence", async () => {
    const repository = new StubAgentRepository();
    const service = new AuthoredDirectiveService({
      repository,
      coherenceChecker: new CapturingChecker(),
      registeredCapabilityNames: new Set(["retrieval.answer"]),
    });

    await expect(service.create(workspaceId, agentId, directiveInput({
      requiredCapabilities: ["retrieval.answer", "missing.capability"],
    }))).rejects.toMatchObject({
      statusCode: 400,
      code: "bad_request",
    });
    expect(repository.created).toHaveLength(0);
  });

  it("rejects directive bindings to unknown, disabled, or routine-only skills", async () => {
    const repository = new StubAgentRepository();
    const agentSkills = new StubAgentSkillRepository();
    agentSkills.skills.push(
      agentSkill({ skillName: "disabled.lookup", enabled: false }),
      agentSkill({ skillName: "routine.lookup", invocationMode: "routine_named" }),
    );
    const service = new AuthoredDirectiveService({
      repository,
      coherenceChecker: new CapturingChecker(),
      registeredCapabilityNames: new Set(),
      agentSkills,
    });

    for (const skillName of ["missing.lookup", "disabled.lookup", "routine.lookup"]) {
      await expect(service.create(workspaceId, agentId, directiveInput({
        binding: { kind: "skill", skillName },
      }))).rejects.toMatchObject({
        statusCode: 400,
        code: "bad_request",
        message: expect.stringContaining(skillName),
      });
    }

    expect(repository.created).toHaveLength(0);
  });

  it("rejects directive bindings to skill kinds that cannot answer chat turns or stage lookup context", async () => {
    const repository = new StubAgentRepository();
    const agentSkills = new StubAgentSkillRepository();
    agentSkills.skills.push(
      agentSkill({ skillName: "crm.webhook", kind: "webhook" }),
    );
    const service = new AuthoredDirectiveService({
      repository,
      coherenceChecker: new CapturingChecker(),
      registeredCapabilityNames: new Set(),
      agentSkills,
    });

    await expect(service.create(workspaceId, agentId, directiveInput({
      binding: { kind: "skill", skillName: "crm.webhook" },
    }))).rejects.toMatchObject({
      statusCode: 400,
      code: "bad_request",
      message: expect.stringContaining("crm.webhook"),
    });

    expect(repository.created).toHaveLength(0);
  });

  it("accepts directive bindings to enabled agent-selectable skills", async () => {
    const repository = new StubAgentRepository();
    const agentSkills = new StubAgentSkillRepository();
    agentSkills.skills.push(
      agentSkill({ skillName: "order.lookup" }),
      agentSkill({ skillName: "grounded.search", kind: "retrieve", targetType: null, targetId: null }),
    );
    const service = new AuthoredDirectiveService({
      repository,
      coherenceChecker: new CapturingChecker(),
      registeredCapabilityNames: new Set(),
      agentSkills,
    });

    await service.create(workspaceId, agentId, directiveInput({
      binding: { kind: "skill", skillName: "order.lookup" },
    }));
    await service.create(workspaceId, agentId, directiveInput({
      binding: { kind: "skill", skillName: "grounded.search" },
    }));

    expect(repository.created.map((created) => created.binding)).toEqual([
      { kind: "skill", skillName: "order.lookup" },
      { kind: "skill", skillName: "grounded.search" },
    ]);
  });

  it("includes built-in directives in the coherence comparison set", async () => {
    const repository = new StubAgentRepository();
    repository.directives.push(persistedDirective(directiveInput({ name: "existing-authored" })));
    const checker = new CapturingChecker();
    const service = new AuthoredDirectiveService({
      repository,
      coherenceChecker: checker,
      registeredCapabilityNames: new Set(),
    });

    await service.create(workspaceId, agentId, directiveInput());

    expect(checker.checks[0]?.existingDirectives.map((directive) => directive.name)).toEqual([
      "existing-authored",
      ...defaultAnswerDirectives.map((directive) => directive.name),
    ]);
  });

  it("excludes disabled directives from the coherence comparison set", async () => {
    const repository = new StubAgentRepository();
    repository.directives.push(
      persistedDirective(directiveInput({ name: "live-directive" })),
      persistedDirective(directiveInput({ name: "disabled-directive" }), { enabled: false }),
    );
    const checker = new CapturingChecker();
    const service = new AuthoredDirectiveService({
      repository,
      coherenceChecker: checker,
      registeredCapabilityNames: new Set(),
    });

    await service.create(workspaceId, agentId, directiveInput());

    // A directive that cannot fire cannot conflict, so it never reaches the checker.
    expect(checker.checks[0]?.existingDirectives.map((directive) => directive.name)).toEqual([
      "live-directive",
      ...defaultAnswerDirectives.map((directive) => directive.name),
    ]);
  });

  it("compares coherence only with directives that address the candidate's surfaces", async () => {
    const repository = new StubAgentRepository();
    repository.directives.push(
      persistedDirective(directiveInput({ name: "answer-only", surfaces: [] })),
      persistedDirective(directiveInput({ name: "suggestion-only", surfaces: ["suggested_questions"] })),
      persistedDirective(directiveInput({
        name: "answer-and-suggestion",
        surfaces: ["answer", "suggested_questions"],
      })),
    );
    const checker = new CapturingChecker();
    const service = new AuthoredDirectiveService({
      repository,
      coherenceChecker: checker,
      registeredCapabilityNames: new Set(),
    });

    await service.create(workspaceId, agentId, directiveInput({
      surfaces: ["suggested_questions"],
    }));

    expect(checker.checks[0]?.existingDirectives.map((directive) => directive.name)).toEqual([
      "suggestion-only",
      "answer-and-suggestion",
    ]);
  });

  it("fails open when the checker throws and still saves the directive", async () => {
    const repository = new StubAgentRepository();
    const service = new AuthoredDirectiveService({
      repository,
      coherenceChecker: {
        async check() {
          throw new Error("model unavailable");
        },
      },
      registeredCapabilityNames: new Set(),
    });

    const result = await service.create(workspaceId, agentId, directiveInput());

    expect(repository.created).toHaveLength(1);
    expect(result.coherence).toEqual({
      coherent: true,
      conflicts: [],
      rationale: "Coherence check unavailable.",
    });
  });

  it("returns conflict verdicts without blocking persistence", async () => {
    const repository = new StubAgentRepository();
    const conflictVerdict: DirectiveCoherenceVerdict = {
      coherent: false,
      conflicts: [{
        directiveName: "concise-readable-formatting",
        reason: "The candidate requires the opposite level of detail.",
      }],
      rationale: "The directive may conflict with concise formatting.",
    };
    const service = new AuthoredDirectiveService({
      repository,
      coherenceChecker: new CapturingChecker(conflictVerdict),
      registeredCapabilityNames: new Set(),
    });

    const result = await service.create(workspaceId, agentId, directiveInput());

    expect(repository.created).toHaveLength(1);
    expect(result.coherence).toEqual(conflictVerdict);
  });

  it("persists priority on create and forwards it with has-own semantics on update", async () => {
    const repository = new StubAgentRepository();
    const existing = persistedDirective(directiveInput({ name: "ranked" }), { priority: 80 });
    repository.directives.push(existing);
    const service = new AuthoredDirectiveService({
      repository,
      coherenceChecker: new CapturingChecker(),
      registeredCapabilityNames: new Set(),
    });

    await service.create(workspaceId, agentId, directiveInput({ priority: 40 }));
    expect(repository.created.at(-1)?.priority).toBe(40);

    // Omitting priority preserves the existing value rather than clearing it.
    await service.update(workspaceId, agentId, existing.id, { action: "Reworded." });
    expect(repository.updated.at(-1)?.input.priority).toBe(80);

    // An explicit value sets it, and explicit null clears it back to the default.
    await service.update(workspaceId, agentId, existing.id, { priority: 95 });
    expect(repository.updated.at(-1)?.input.priority).toBe(95);

    await service.update(workspaceId, agentId, existing.id, { priority: null });
    expect(repository.updated.at(-1)?.input.priority).toBeNull();
  });

  it("defaults enabled to true on create, and forwards it with has-own semantics on update", async () => {
    const repository = new StubAgentRepository();
    const service = new AuthoredDirectiveService({
      repository,
      coherenceChecker: new CapturingChecker(),
      registeredCapabilityNames: new Set(),
    });

    const enabledOnCreate = await service.create(workspaceId, agentId, directiveInput({ name: "on-by-default" }));
    expect(enabledOnCreate.directive.enabled).toBe(true);
    expect(repository.created.at(-1)?.enabled).toBe(true);

    const disabled = await service.create(workspaceId, agentId, directiveInput({ name: "off", enabled: false }));
    expect(disabled.directive.enabled).toBe(false);
    expect(repository.created.at(-1)?.enabled).toBe(false);

    // Omitting enabled on update preserves the stored value rather than resetting it to true.
    await service.update(workspaceId, agentId, disabled.directive.id, { action: "Reworded." });
    expect(repository.updated.at(-1)?.input.enabled).toBe(false);

    // An explicit value flips it.
    await service.update(workspaceId, agentId, disabled.directive.id, { enabled: true });
    expect(repository.updated.at(-1)?.input.enabled).toBe(true);
  });

  it("preserves every stored optional field when an update names only one unrelated field", async () => {
    // Regression test for the whole class of bug, not just lifecycle: every field the schema
    // knows about must survive an update that never mentions it. Each field below is seeded with
    // a non-default value; if the service's merge omits a field (the historical bug for
    // `lifecycle`), that field silently reverts to the schema default here and the structural
    // comparison below catches it, including for a field added after this test was written.
    const repository = new StubAgentRepository();
    const existing = persistedDirective(directiveInput({
      name: "full-directive",
      condition: { kind: "contextual", description: "When the customer asks about refunds." },
      action: "Escalate to a human.",
      requiredCapabilities: ["custom.capability"],
      dependsOn: ["some-other-directive"],
      excludes: ["conflicting-directive"],
      surfaces: ["suggested_questions"],
      tags: ["tag-a", "tag-b"],
      description: "A fully populated directive.",
      binding: { kind: "skill", skillName: "order.lookup" },
      // Disabled so validateBinding and the capability/coherence checks - which are only run
      // for a directive that can actually fire - don't need real dependencies wired up here;
      // this test is only about which fields the merge carries forward.
      enabled: false,
    }), {
      priority: 42,
      lifecycle: { kind: "cooldown", turns: 3 },
      metadata: { source: "operator" },
    });
    repository.directives.push(existing);
    const service = new AuthoredDirectiveService({
      repository,
      coherenceChecker: new CapturingChecker(),
      registeredCapabilityNames: new Set(),
    });

    await service.update(workspaceId, agentId, existing.id, { name: "renamed-directive" });

    // Built from `existing` itself (minus the repository-owned fields and the one field this
    // update actually changed) rather than a hand-typed object, so a field this test doesn't
    // even know about yet still has to round-trip correctly.
    const { id: _id, agentId: _agentId, createdAt: _createdAt, updatedAt: _updatedAt, ...carriedForward } = existing;
    expect(repository.updated.at(-1)?.input).toEqual({
      ...carriedForward,
      name: "renamed-directive",
      routes: [],
    });
  });

  it("clears lifecycle and priority only when the caller explicitly sets them to null, not when they're omitted", async () => {
    const repository = new StubAgentRepository();
    const existing = persistedDirective(directiveInput({ name: "cooldown-rule" }), {
      priority: 42,
      lifecycle: { kind: "cooldown", turns: 3 },
    });
    repository.directives.push(existing);
    const service = new AuthoredDirectiveService({
      repository,
      coherenceChecker: new CapturingChecker(),
      registeredCapabilityNames: new Set(),
    });

    // Omitting both preserves the stored values.
    await service.update(workspaceId, agentId, existing.id, { action: "Reworded." });
    expect(repository.updated.at(-1)?.input.lifecycle).toEqual({ kind: "cooldown", turns: 3 });
    expect(repository.updated.at(-1)?.input.priority).toBe(42);

    // Explicit null clears each back to the schema default - the distinction this whole
    // has-own-property scheme exists to preserve.
    await service.update(workspaceId, agentId, existing.id, { lifecycle: null, priority: null });
    expect(repository.updated.at(-1)?.input.lifecycle).toBeNull();
    expect(repository.updated.at(-1)?.input.priority).toBeNull();
  });

  it("skips the coherence check and returns a coherent verdict when a directive is updated to disabled", async () => {
    const repository = new StubAgentRepository();
    const existing = persistedDirective(directiveInput({ name: "flaky-rule" }));
    repository.directives.push(existing);
    const checker = new CapturingChecker();
    const service = new AuthoredDirectiveService({
      repository,
      coherenceChecker: checker,
      registeredCapabilityNames: new Set(),
    });

    const result = await service.update(workspaceId, agentId, existing.id, { enabled: false });

    // Turning a directive off is the emergency action an operator takes when a rule
    // misfires; it should not cost an LLM round-trip whose verdict the UI discards.
    expect(checker.checks).toHaveLength(0);
    expect(result.coherence.coherent).toBe(true);
    expect(result.coherence.conflicts).toEqual([]);
    expect(result.coherence.rationale).not.toBe("Coherence check unavailable.");
  });

  it("still runs the coherence check when a directive is updated back to enabled", async () => {
    const repository = new StubAgentRepository();
    const existing = persistedDirective(directiveInput({ name: "recovering-rule" }), { enabled: false });
    repository.directives.push(existing);
    const checker = new CapturingChecker(coherentVerdict);
    const service = new AuthoredDirectiveService({
      repository,
      coherenceChecker: checker,
      registeredCapabilityNames: new Set(),
    });

    const result = await service.update(workspaceId, agentId, existing.id, { enabled: true });

    // Re-enabling brings the directive back into play, which can reintroduce a
    // conflict - exactly when the operator wants to be told.
    expect(checker.checks).toHaveLength(1);
    expect(result.coherence).toEqual(coherentVerdict);
  });

  it("skips the coherence check when a directive is created as disabled", async () => {
    const repository = new StubAgentRepository();
    const checker = new CapturingChecker();
    const service = new AuthoredDirectiveService({
      repository,
      coherenceChecker: checker,
      registeredCapabilityNames: new Set(),
    });

    const result = await service.create(workspaceId, agentId, directiveInput({ name: "born-off", enabled: false }));

    expect(checker.checks).toHaveLength(0);
    expect(result.coherence.coherent).toBe(true);
    expect(result.coherence.conflicts).toEqual([]);
  });

  it("saves a directive turned off even when its bound skill is disabled or missing", async () => {
    const repository = new StubAgentRepository();
    const existing = persistedDirective(directiveInput({
      name: "broken-binding-rule",
      binding: { kind: "skill", skillName: "order.lookup" },
      surfaces: ["answer"],
    }));
    repository.directives.push(existing);
    // order.lookup is not registered with the agent's skills at all, simulating a
    // deleted skill; the binding is exactly the kind of broken state an operator
    // would want to switch off.
    const agentSkills = new StubAgentSkillRepository();
    const service = new AuthoredDirectiveService({
      repository,
      coherenceChecker: new CapturingChecker(),
      registeredCapabilityNames: new Set(),
      agentSkills,
    });

    const result = await service.update(workspaceId, agentId, existing.id, { enabled: false });

    expect(result.directive.enabled).toBe(false);
    expect(repository.updated.at(-1)?.input.enabled).toBe(false);
    expect(repository.updated.at(-1)?.input.binding).toEqual({ kind: "skill", skillName: "order.lookup" });
  });

  it("saves a directive turned off even when it requires a capability that no longer exists", async () => {
    const repository = new StubAgentRepository();
    const existing = persistedDirective(directiveInput({
      name: "stale-capability-rule",
      requiredCapabilities: ["retired.capability"],
    }));
    repository.directives.push(existing);
    // An update carries the stored capabilities forward untouched, so a capability removed or
    // renamed in code would otherwise make this directive impossible to switch off.
    const service = new AuthoredDirectiveService({
      repository,
      coherenceChecker: new CapturingChecker(),
      registeredCapabilityNames: new Set(),
    });

    const result = await service.update(workspaceId, agentId, existing.id, { enabled: false });

    expect(result.directive.enabled).toBe(false);
    expect(repository.updated.at(-1)?.input.requiredCapabilities).toEqual(["retired.capability"]);
  });

  it("rejects re-enabling a directive that requires a capability that no longer exists", async () => {
    const repository = new StubAgentRepository();
    const existing = persistedDirective(directiveInput({
      name: "stale-capability-rule",
      requiredCapabilities: ["retired.capability"],
    }), { enabled: false });
    repository.directives.push(existing);
    const service = new AuthoredDirectiveService({
      repository,
      coherenceChecker: new CapturingChecker(),
      registeredCapabilityNames: new Set(),
    });

    await expect(service.update(workspaceId, agentId, existing.id, { enabled: true }))
      .rejects.toThrow(/unknown capabilities/i);
  });

  it("rejects re-enabling a directive whose bound skill is still disabled or missing", async () => {
    const repository = new StubAgentRepository();
    const existing = persistedDirective(directiveInput({
      name: "broken-binding-rule",
      binding: { kind: "skill", skillName: "order.lookup" },
      surfaces: ["answer"],
    }), { enabled: false });
    repository.directives.push(existing);
    const agentSkills = new StubAgentSkillRepository();
    const service = new AuthoredDirectiveService({
      repository,
      coherenceChecker: new CapturingChecker(),
      registeredCapabilityNames: new Set(),
      agentSkills,
    });

    // Bringing the directive back into play must still validate the binding, since
    // that is exactly when a broken binding would matter again at runtime.
    await expect(service.update(workspaceId, agentId, existing.id, { enabled: true })).rejects.toMatchObject({ statusCode: 400 });
  });

  it("saves a directive turned off even when its binding is scoped away from the reply", async () => {
    const repository = new StubAgentRepository();
    const existing = persistedDirective(directiveInput({
      name: "scoped-away-rule",
      binding: { kind: "skill", skillName: "order.lookup" },
      surfaces: ["suggested_questions"],
    }));
    repository.directives.push(existing);
    const agentSkills = new StubAgentSkillRepository();
    agentSkills.skills.push(agentSkill({ skillName: "order.lookup" }));
    const service = new AuthoredDirectiveService({
      repository,
      coherenceChecker: new CapturingChecker(),
      registeredCapabilityNames: new Set(),
      agentSkills,
    });

    // The surface-scope rejection is the same class of authoring-time-only rule as the
    // skill lookups, so it skips too when the guard sits at validateBinding's entry.
    const result = await service.update(workspaceId, agentId, existing.id, { enabled: false });

    expect(result.directive.enabled).toBe(false);
  });

  it("creates a directive turned off with an invalid binding without validating it", async () => {
    const repository = new StubAgentRepository();
    const agentSkills = new StubAgentSkillRepository();
    const service = new AuthoredDirectiveService({
      repository,
      coherenceChecker: new CapturingChecker(),
      registeredCapabilityNames: new Set(),
      agentSkills,
    });

    const result = await service.create(workspaceId, agentId, directiveInput({
      name: "born-off-broken-binding",
      binding: { kind: "skill", skillName: "order.lookup" },
      surfaces: ["answer"],
      enabled: false,
    }));

    expect(result.directive.enabled).toBe(false);
    expect(repository.created.at(-1)?.binding).toEqual({ kind: "skill", skillName: "order.lookup" });
  });

  it("rejects a skill binding on a directive scoped away from the reply", async () => {
    const repository = new StubAgentRepository();
    const agentSkills = new StubAgentSkillRepository();
    agentSkills.skills.push(agentSkill({ skillName: "order.lookup" }));
    const service = new AuthoredDirectiveService({
      repository,
      coherenceChecker: new CapturingChecker(),
      registeredCapabilityNames: new Set(),
      agentSkills,
    });

    await expect(service.create(workspaceId, agentId, directiveInput({
      binding: { kind: "skill", skillName: "order.lookup" },
      surfaces: ["suggested_questions"],
    }))).rejects.toMatchObject({ statusCode: 400 });
  });

  it("allows a skill binding when the directive still addresses the reply", async () => {
    const repository = new StubAgentRepository();
    const agentSkills = new StubAgentSkillRepository();
    agentSkills.skills.push(agentSkill({ skillName: "order.lookup" }));
    const service = new AuthoredDirectiveService({
      repository,
      coherenceChecker: new CapturingChecker(),
      registeredCapabilityNames: new Set(),
      agentSkills,
    });

    const created = await service.create(workspaceId, agentId, directiveInput({
      binding: { kind: "skill", skillName: "order.lookup" },
      surfaces: ["answer", "suggested_questions"],
    }));

    expect(created.directive.binding).toEqual({ kind: "skill", skillName: "order.lookup" });
  });

  it("keeps a directive's generation surface scope across an unrelated edit", async () => {
    const repository = new StubAgentRepository();
    const service = new AuthoredDirectiveService({
      repository,
      coherenceChecker: new CapturingChecker(),
      registeredCapabilityNames: new Set(),
      agentSkills: new StubAgentSkillRepository(),
    });

    const created = await service.create(workspaceId, agentId, directiveInput({
      surfaces: ["suggested_questions"],
    }));
    expect(created.directive.surfaces).toEqual(["suggested_questions"]);

    await service.update(workspaceId, agentId, created.directive.id, {
      action: "Never suggest a follow-up question about price or discounts.",
    });

    expect(repository.updated.at(-1)?.input.surfaces).toEqual(["suggested_questions"]);
  });

  it("widens a directive back to the answering voice when the operator clears the scope", async () => {
    const repository = new StubAgentRepository();
    const service = new AuthoredDirectiveService({
      repository,
      coherenceChecker: new CapturingChecker(),
      registeredCapabilityNames: new Set(),
      agentSkills: new StubAgentSkillRepository(),
    });

    const created = await service.create(workspaceId, agentId, directiveInput({
      surfaces: ["suggested_questions"],
    }));

    await service.update(workspaceId, agentId, created.directive.id, { surfaces: [] });

    expect(repository.updated.at(-1)?.input.surfaces).toEqual([]);
  });

  it("deletes when expectedUpdatedAt matches the directive's current version", async () => {
    const repository = new StubAgentRepository();
    const existing = persistedDirective(directiveInput({ name: "sunset-me" }));
    repository.directives.push(existing);
    const service = new AuthoredDirectiveService({
      repository,
      coherenceChecker: new CapturingChecker(),
      registeredCapabilityNames: new Set(),
    });

    await service.delete(workspaceId, agentId, existing.id, { expectedUpdatedAt: existing.updatedAt });

    expect(repository.directives.find((directive) => directive.id === existing.id)).toBeUndefined();
  });

  it("raises a conflict and keeps the directive intact when expectedUpdatedAt no longer matches (concurrent edit)", async () => {
    const repository = new StubAgentRepository();
    const existing = persistedDirective(directiveInput({ name: "edited-after-draft" }));
    repository.directives.push(existing);
    const service = new AuthoredDirectiveService({
      repository,
      coherenceChecker: new CapturingChecker(),
      registeredCapabilityNames: new Set(),
    });

    // Simulates an edit made after the caller read the directive's version token but before it
    // called delete: the version passed to delete() no longer matches what is stored.
    const staleExpectedUpdatedAt = new Date(existing.updatedAt.getTime() - 1_000);

    await expect(
      service.delete(workspaceId, agentId, existing.id, { expectedUpdatedAt: staleExpectedUpdatedAt }),
    ).rejects.toMatchObject({ statusCode: 409, code: "conflict" } as Partial<AppError>);

    // The directive must survive a stale delete attempt - the same guarantee update() already has.
    expect(repository.directives.find((directive) => directive.id === existing.id)).toEqual(existing);
  });

  it("deletes without gating when no expectedUpdatedAt is supplied, matching pre-existing non-copilot callers", async () => {
    const repository = new StubAgentRepository();
    const existing = persistedDirective(directiveInput({ name: "ungated-delete" }));
    repository.directives.push(existing);
    const service = new AuthoredDirectiveService({
      repository,
      coherenceChecker: new CapturingChecker(),
      registeredCapabilityNames: new Set(),
    });

    await service.delete(workspaceId, agentId, existing.id);

    expect(repository.directives.find((directive) => directive.id === existing.id)).toBeUndefined();
  });
});

describe("InMemoryAgentRepository directive uniqueness", () => {
  it("rejects duplicate directive creates with a conflict", async () => {
    const repository = new InMemoryAgentRepository();
    const agent = await repository.create(workspaceId, { name: "Test agent" });
    await repository.createDirective(agent.id, workspaceId, directiveInput({ name: "formal-register" }));

    await expect(repository.createDirective(agent.id, workspaceId, directiveInput({ name: "formal-register" })))
      .rejects.toMatchObject({
        statusCode: 409,
        code: "conflict",
        message: 'A directive named "formal-register" already exists for this agent.',
      } as Partial<AppError>);
  });

  it("rejects directive renames to an existing name with a conflict", async () => {
    const repository = new InMemoryAgentRepository();
    const agent = await repository.create(workspaceId, { name: "Test agent" });
    await repository.createDirective(agent.id, workspaceId, directiveInput({ name: "formal-register" }));
    const second = await repository.createDirective(agent.id, workspaceId, directiveInput({ name: "handoff-tone" }));

    await expect(repository.updateDirective(agent.id, workspaceId, second.id, { name: "formal-register" }))
      .rejects.toMatchObject({
        statusCode: 409,
        code: "conflict",
        message: 'A directive named "formal-register" already exists for this agent.',
      } as Partial<AppError>);
  });

  it("round-trips an authored priority and clears it back to the default", async () => {
    const repository = new InMemoryAgentRepository();
    const agent = await repository.create(workspaceId, { name: "Test agent" });

    const created = await repository.createDirective(agent.id, workspaceId, directiveInput({ name: "ranked", priority: 70 }));
    expect(created.priority).toBe(70);

    const untouched = await repository.updateDirective(agent.id, workspaceId, created.id, { action: "Reworded." });
    expect(untouched.priority).toBe(70);

    const set = await repository.updateDirective(agent.id, workspaceId, created.id, { priority: 95 });
    expect(set.priority).toBe(95);

    const cleared = await repository.updateDirective(agent.id, workspaceId, created.id, { priority: null });
    expect(cleared.priority).toBeNull();
  });
});
