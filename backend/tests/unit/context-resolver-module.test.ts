import { describe, expect, it, vi } from "vitest";

import { SkillBackedContextResolver } from "../../src/app/composition/builtIn/contextResolverModule.js";
import type { AgentSkillRepositoryPort } from "../../src/modules/agentSkills/public.js";
import type { AgentSkillSpine } from "../../src/modules/agentSkills/public.js";
import {
  SkillExecutorRegistry,
  type SkillExecutorPort,
  type SkillInvocation,
  type SkillOutcome,
} from "../../src/modules/skills/public.js";

const workspaceId = "workspace-1";
const agentId = "agent-1";
const resolverSkillId = "skill-1";
const scope = { type: "session" as const, id: "session-1" };
const execution = { kind: "internal" as const, adapter: "resolver-test", enqueue: false };

const agentSkill = (overrides: Partial<AgentSkillSpine> = {}): AgentSkillSpine => ({
  id: resolverSkillId,
  workspaceId,
  agentId,
  skillName: "fetch_order_status",
  kind: "external_mcp",
  invocationMode: "routine_named",
  enabled: true,
  targetType: null,
  targetId: null,
  config: { execution },
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  updatedAt: new Date("2026-06-01T00:00:00.000Z"),
  ...overrides,
});

const settledExecutor = (
  outcome: SkillOutcome,
  capture?: (invocation: SkillInvocation) => void,
): SkillExecutorPort => ({
  async dispatch(invocation) {
    capture?.(invocation);
    return { disposition: "settled", outcome };
  },
});

const deferredExecutor: SkillExecutorPort = {
  async dispatch() {
    return { disposition: "deferred", ticket: { ticketId: "ticket-1" } };
  },
};

const registryWith = (executor: SkillExecutorPort): SkillExecutorRegistry => {
  const registry = new SkillExecutorRegistry();
  registry.register({ ...execution, executor });
  return registry;
};

const repositoryWith = (skill: AgentSkillSpine | null): Pick<AgentSkillRepositoryPort, "findById"> => ({
  findById: vi.fn(async () => skill),
});

describe("SkillBackedContextResolver", () => {
  it("dispatches a settled resolver skill and extracts the returned value", async () => {
    let invocation: SkillInvocation | undefined;
    const resolver = new SkillBackedContextResolver({
      agentSkills: repositoryWith(agentSkill()),
      skillExecutorRegistry: registryWith(settledExecutor({
        status: "completed",
        outputs: { value: { state: "shipped" } },
      } as SkillOutcome, (nextInvocation) => {
        invocation = nextInvocation;
      })),
    });

    await expect(resolver.resolve({
      workspaceId,
      agentId,
      resolverSkillId,
      variableName: "order_status",
      scope,
    })).resolves.toEqual({ value: { state: "shipped" } });

    expect(invocation).toMatchObject({
      skill: {
        name: "fetch_order_status",
        execution,
      },
      collected: {
        variableName: "order_status",
        scope,
      },
      context: {
        workspaceId,
        agentId,
        sessionId: "session-1",
        variableName: "order_status",
      },
    });
  });

  it("returns null for missing or disabled skills", async () => {
    const registry = registryWith(settledExecutor({
      status: "completed",
      outputs: { value: "ok" },
    } as SkillOutcome));

    await expect(new SkillBackedContextResolver({
      agentSkills: repositoryWith(null),
      skillExecutorRegistry: registry,
    }).resolve({ workspaceId, agentId, resolverSkillId, variableName: "order_status", scope })).resolves.toBeNull();

    await expect(new SkillBackedContextResolver({
      agentSkills: repositoryWith(agentSkill({ enabled: false })),
      skillExecutorRegistry: registry,
    }).resolve({ workspaceId, agentId, resolverSkillId, variableName: "order_status", scope })).resolves.toBeNull();
  });

  it("returns null when no executor is registered", async () => {
    const resolver = new SkillBackedContextResolver({
      agentSkills: repositoryWith(agentSkill()),
      skillExecutorRegistry: new SkillExecutorRegistry(),
    });

    await expect(resolver.resolve({
      workspaceId,
      agentId,
      resolverSkillId,
      variableName: "order_status",
      scope,
    })).resolves.toBeNull();
  });

  it("returns null for deferred or failed outcomes", async () => {
    await expect(new SkillBackedContextResolver({
      agentSkills: repositoryWith(agentSkill()),
      skillExecutorRegistry: registryWith(deferredExecutor),
    }).resolve({ workspaceId, agentId, resolverSkillId, variableName: "order_status", scope })).resolves.toBeNull();

    await expect(new SkillBackedContextResolver({
      agentSkills: repositoryWith(agentSkill()),
      skillExecutorRegistry: registryWith(settledExecutor({
        status: "failed",
        outputs: { value: "nope" },
      } as SkillOutcome)),
    }).resolve({ workspaceId, agentId, resolverSkillId, variableName: "order_status", scope })).resolves.toBeNull();
  });
});
