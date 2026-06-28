import { describe, expect, it, vi } from "vitest";

import type {
  AgentContextVariableEnablement,
  ContextVariable,
  ContextVariableScope,
  ContextVariableValue,
  ResolvedVariableInput,
} from "../../src/modules/context-variables/public.js";
import { ContextVariableResolverService, type ContextResolverPort } from "../../src/modules/context-variables/public.js";
import type {
  AgentContextVariableEnablementRecord,
  ContextVariableCreateRecord,
  ContextVariableRepositoryPort,
  ContextVariableUpdateRecord,
} from "../../src/db/repositories/contextVariableRepository.js";

const workspaceId = "workspace-1";
const agentId = "agent-1";
const sessionScope: ContextVariableScope = { type: "session", id: "session-1" };
const agentScope: ContextVariableScope = { type: "agent", id: agentId };
const scopes = [sessionScope, agentScope];
const nowMs = Date.parse("2026-06-24T10:00:00.000Z");

const variable = (overrides: Partial<ContextVariable> = {}): ContextVariable => ({
  id: "var-1",
  workspaceId,
  name: "order_status",
  description: "Current order state",
  valueType: "json",
  trustTier: "signed",
  sensitivity: "sensitive",
  defaultSurfacing: "always",
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  updatedAt: new Date("2026-06-01T00:00:00.000Z"),
  ...overrides,
});

const enablement = (
  overrides: Partial<AgentContextVariableEnablement> = {},
): AgentContextVariableEnablement => ({
  id: "enablement-1",
  agentId,
  variableId: "var-1",
  source: "resolver",
  resolverSkillId: "skill-1",
  maxAgeSeconds: 60,
  resolverTimeoutMs: 25,
  surfacing: "on_reference",
  enabled: true,
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  updatedAt: new Date("2026-06-01T00:00:00.000Z"),
  variable: variable(),
  ...overrides,
});

const value = (
  data: unknown,
  lastModified: Date,
): ContextVariableValue => ({
  id: "value-1",
  workspaceId,
  variableId: "var-1",
  scope: sessionScope,
  data,
  lastModified,
});

class FakeContextVariableRepository implements ContextVariableRepositoryPort {
  readonly resolveForAgent = vi.fn<ContextVariableRepositoryPort["resolveForAgent"]>();
  readonly listByAgent = vi.fn<ContextVariableRepositoryPort["listByAgent"]>();
  readonly readValue = vi.fn<ContextVariableRepositoryPort["readValue"]>();
  readonly upsertValue = vi.fn<ContextVariableRepositoryPort["upsertValue"]>();

  create(_input: ContextVariableCreateRecord): Promise<ContextVariable> {
    throw new Error("not implemented");
  }
  update(_workspaceId: string, _id: string, _input: ContextVariableUpdateRecord): Promise<ContextVariable | null> {
    throw new Error("not implemented");
  }
  delete(_workspaceId: string, _id: string): Promise<boolean> {
    throw new Error("not implemented");
  }
  listByWorkspace(_workspaceId: string): Promise<ContextVariable[]> {
    throw new Error("not implemented");
  }
  get(_workspaceId: string, _id: string): Promise<ContextVariable | null> {
    throw new Error("not implemented");
  }
  upsertEnablement(_input: AgentContextVariableEnablementRecord): Promise<AgentContextVariableEnablement> {
    throw new Error("not implemented");
  }
  deleteEnablement(_agentId: string, _variableId: string): Promise<boolean> {
    throw new Error("not implemented");
  }
  deleteValue(_variableId: string, _scope: ContextVariableScope): Promise<boolean> {
    throw new Error("not implemented");
  }
}

const createService = (input: {
  repository?: FakeContextVariableRepository;
  resolver?: ContextResolverPort;
  now?: () => number;
} = {}): {
  repository: FakeContextVariableRepository;
  resolver: ContextResolverPort;
  service: ContextVariableResolverService;
} => {
  const repository = input.repository ?? new FakeContextVariableRepository();
  if (!input.repository) {
    repository.resolveForAgent.mockResolvedValue([]);
    repository.listByAgent.mockResolvedValue([]);
    repository.readValue.mockResolvedValue(null);
    repository.upsertValue.mockImplementation(async (variableId, scope, data) => ({
      id: "upserted-value",
      workspaceId,
      variableId,
      scope,
      data,
      lastModified: new Date(nowMs),
    }));
  }
  const resolver = input.resolver ?? { resolve: vi.fn(async () => null) };
  return {
    repository,
    resolver,
    service: new ContextVariableResolverService({
      repository,
      resolver,
      now: input.now ?? (() => nowMs),
    }),
  };
};

describe("ContextVariableResolverService", () => {
  it("delegates pushed variables to the repository and appends resolver variables", async () => {
    const pushed: ResolvedVariableInput = {
      name: "plan",
      description: null,
      value: "pro",
      surfacing: "always",
      sensitive: false,
      trust: "unverified",
    };
    const repository = new FakeContextVariableRepository();
    repository.resolveForAgent.mockResolvedValue([pushed]);
    repository.listByAgent.mockResolvedValue([enablement()]);
    repository.readValue.mockResolvedValue(null);
    const resolver: ContextResolverPort = { resolve: vi.fn(async () => ({ value: { state: "shipped" } })) };
    const { service } = createService({ repository, resolver });

    await expect(service.resolveForAgent(workspaceId, agentId, scopes)).resolves.toEqual([
      pushed,
      {
        name: "order_status",
        description: "Current order state",
        value: { state: "shipped" },
        surfacing: "on_reference",
        sensitive: true,
        trust: "verified",
      },
    ]);
    expect(repository.resolveForAgent).toHaveBeenCalledWith(workspaceId, agentId, scopes);
  });

  it("uses a fresh resolver cache hit without calling the resolver", async () => {
    const repository = new FakeContextVariableRepository();
    repository.resolveForAgent.mockResolvedValue([]);
    repository.listByAgent.mockResolvedValue([enablement({ maxAgeSeconds: 60 })]);
    repository.readValue.mockResolvedValue(value({ state: "cached" }, new Date(nowMs - 30_000)));
    const resolver: ContextResolverPort = { resolve: vi.fn(async () => ({ value: { state: "fresh" } })) };
    const { service } = createService({ repository, resolver });

    await expect(service.resolveForAgent(workspaceId, agentId, scopes)).resolves.toMatchObject([
      {
        name: "order_status",
        value: { state: "cached" },
      },
    ]);
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(repository.upsertValue).not.toHaveBeenCalled();
  });

  it("skips incompatible cached resolver values without calling the resolver", async () => {
    const repository = new FakeContextVariableRepository();
    repository.resolveForAgent.mockResolvedValue([]);
    repository.listByAgent.mockResolvedValue([
      enablement({ maxAgeSeconds: 60, variable: variable({ valueType: "string" }) }),
    ]);
    repository.readValue.mockResolvedValue(value({ state: "cached" }, new Date(nowMs - 30_000)));
    const resolver: ContextResolverPort = { resolve: vi.fn(async () => ({ value: "fresh" })) };
    const { service } = createService({ repository, resolver });

    await expect(service.resolveForAgent(workspaceId, agentId, scopes)).resolves.toEqual([]);
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(repository.upsertValue).not.toHaveBeenCalled();
  });

  it("fetches and caches stale or absent resolver values using the most-specific scope", async () => {
    const repository = new FakeContextVariableRepository();
    repository.resolveForAgent.mockResolvedValue([]);
    repository.listByAgent.mockResolvedValue([enablement({ maxAgeSeconds: 60 })]);
    repository.readValue.mockResolvedValue(value({ state: "old" }, new Date(nowMs - 90_000)));
    const resolver: ContextResolverPort = { resolve: vi.fn(async () => ({ value: { state: "updated" } })) };
    const { service } = createService({ repository, resolver });

    await expect(service.resolveForAgent(workspaceId, agentId, scopes)).resolves.toMatchObject([
      {
        name: "order_status",
        value: { state: "updated" },
      },
    ]);
    expect(repository.readValue).toHaveBeenCalledWith("var-1", sessionScope);
    expect(resolver.resolve).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId,
      agentId,
      resolverSkillId: "skill-1",
      variableName: "order_status",
      scope: sessionScope,
      signal: expect.any(AbortSignal),
    }));
    expect(repository.upsertValue).toHaveBeenCalledWith("var-1", sessionScope, { state: "updated" });
  });

  it("treats a null max age as never fresh and refetches every turn", async () => {
    const repository = new FakeContextVariableRepository();
    repository.resolveForAgent.mockResolvedValue([]);
    repository.listByAgent.mockResolvedValue([enablement({ maxAgeSeconds: null })]);
    repository.readValue.mockResolvedValue(value({ state: "cached" }, new Date(nowMs)));
    const resolver: ContextResolverPort = { resolve: vi.fn(async () => ({ value: { state: "new" } })) };
    const { service } = createService({ repository, resolver });

    await service.resolveForAgent(workspaceId, agentId, scopes);

    expect(resolver.resolve).toHaveBeenCalledTimes(1);
    expect(repository.upsertValue).toHaveBeenCalledWith("var-1", sessionScope, { state: "new" });
  });

  it("skips incompatible fetched resolver values without caching them", async () => {
    const repository = new FakeContextVariableRepository();
    repository.resolveForAgent.mockResolvedValue([]);
    repository.listByAgent.mockResolvedValue([
      enablement({ variable: variable({ valueType: "string" }) }),
    ]);
    repository.readValue.mockResolvedValue(null);
    const resolver: ContextResolverPort = { resolve: vi.fn(async () => ({ value: { state: "object" } })) };
    const { service } = createService({ repository, resolver });

    await expect(service.resolveForAgent(workspaceId, agentId, scopes)).resolves.toEqual([]);
    expect(repository.upsertValue).not.toHaveBeenCalled();
  });

  it("skips resolver failures without throwing and preserves pushed values", async () => {
    const pushed: ResolvedVariableInput = {
      name: "plan",
      description: null,
      value: "pro",
      surfacing: "always",
      sensitive: false,
      trust: "unverified",
    };
    const repository = new FakeContextVariableRepository();
    repository.resolveForAgent.mockResolvedValue([pushed]);
    repository.listByAgent.mockResolvedValue([enablement()]);
    repository.readValue.mockResolvedValue(null);
    const resolver: ContextResolverPort = { resolve: vi.fn(async () => { throw new Error("down"); }) };
    const { service } = createService({ repository, resolver });

    await expect(service.resolveForAgent(workspaceId, agentId, scopes)).resolves.toEqual([pushed]);
    expect(repository.upsertValue).not.toHaveBeenCalled();
  });

  it("skips resolver null results and timeouts without throwing", async () => {
    const repository = new FakeContextVariableRepository();
    repository.resolveForAgent.mockResolvedValue([]);
    repository.listByAgent.mockResolvedValue([
      enablement({ id: "null-result", variableId: "var-1", resolverSkillId: "skill-null" }),
      enablement({
        id: "timeout",
        variableId: "var-2",
        resolverSkillId: "skill-timeout",
        resolverTimeoutMs: 1,
        variable: variable({ id: "var-2", name: "slow_status" }),
      }),
    ]);
    repository.readValue.mockResolvedValue(null);
    const resolver: ContextResolverPort = {
      resolve: vi.fn(async (input): Promise<{ value: unknown } | null> => {
        if (input.resolverSkillId === "skill-null") {
          return null;
        }
        return new Promise((resolve) => setTimeout(() => resolve({ value: "late" }), 20));
      }),
    };
    const { service } = createService({ repository, resolver });

    await expect(service.resolveForAgent(workspaceId, agentId, scopes)).resolves.toEqual([]);
    expect(repository.upsertValue).not.toHaveBeenCalled();
  });

  it("maps surfacing, sensitivity, and trust from resolver-backed declarations", async () => {
    const repository = new FakeContextVariableRepository();
    repository.resolveForAgent.mockResolvedValue([]);
    repository.listByAgent.mockResolvedValue([
      enablement({
        surfacing: "operator_only",
        variable: variable({
          sensitivity: "normal",
          trustTier: "unverified",
          description: null,
        }),
      }),
    ]);
    repository.readValue.mockResolvedValue(null);
    const resolver: ContextResolverPort = { resolve: vi.fn(async () => ({ value: "ok" })) };
    const { service } = createService({ repository, resolver });

    await expect(service.resolveForAgent(workspaceId, agentId, scopes)).resolves.toEqual([
      {
        name: "order_status",
        description: null,
        value: "ok",
        surfacing: "operator_only",
        sensitive: false,
        trust: "unverified",
      },
    ]);
  });
});
