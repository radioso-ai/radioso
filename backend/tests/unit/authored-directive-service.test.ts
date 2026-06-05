import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { AuthoredDirectiveService } from "../../src/modules/agents/public.js";
import type { AuthoredDirective, AuthoredDirectiveInput, AuthoredDirectiveServiceOptions } from "../../src/modules/agents/public.js";
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
    routes: [],
    description: input.description ?? null,
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
      requiredCapabilities: input.requiredCapabilities ?? existing?.requiredCapabilities ?? [],
      dependsOn: input.dependsOn ?? existing?.dependsOn ?? [],
      excludes: input.excludes ?? existing?.excludes ?? [],
    });
    return { ...merged, id: directiveId };
  }

  async deleteDirective(): Promise<boolean> {
    return true;
  }
}

class CapturingChecker implements DirectiveCoherenceChecker {
  readonly checks: Array<{ candidate: Directive; existingDirectives: Directive[] }> = [];

  constructor(private readonly verdict: DirectiveCoherenceVerdict = coherentVerdict) {}

  async check(input: { candidate: Directive; existingDirectives: Directive[] }): Promise<DirectiveCoherenceVerdict> {
    this.checks.push({
      candidate: input.candidate,
      existingDirectives: input.existingDirectives,
    });
    return this.verdict;
  }
}

describe("AuthoredDirectiveService", () => {
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
});
