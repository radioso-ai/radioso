import { describe, expect, it, vi } from "vitest";

import {
  CONTEXT_VARIABLE_SOURCES,
  classificationRefusal,
  readsStoredValue,
} from "../../src/modules/context-variables/domain.js";
import type {
  AgentContextVariableEnablement,
  ContextVariable,
  ContextVariableOption,
} from "../../src/modules/context-variables/domain.js";
import type { ContextVariableRepositoryPort } from "../../src/modules/context-variables/repository.js";
import { ContextVariableService } from "../../src/modules/context-variables/services/contextVariableService.js";
import { CONTEXT_VARIABLES_BEHAVIOR } from "../../src/shared/domain/behaviorConfig.js";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const variableId = "00000000-0000-4000-8000-000000000002";
const agentId = "00000000-0000-4000-8000-000000000003";

const option = (key: string): ContextVariableOption => ({ key, label: key, description: null, archived: false });

const choice = (overrides: Partial<ContextVariable> = {}): ContextVariable => ({
  id: variableId,
  workspaceId,
  name: "topic",
  description: null,
  valueType: "enum",
  options: [option("billing"), option("shipping")],
  trustTier: "unverified",
  sensitivity: "normal",
  defaultSurfacing: "on_reference",
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides,
});

const enablement = (id: string, overrides: Partial<AgentContextVariableEnablement> = {}): AgentContextVariableEnablement => ({
  id: `enablement-${id}`,
  agentId,
  variableId: id,
  source: "classified",
  resolverSkillId: null,
  maxAgeSeconds: null,
  resolverTimeoutMs: null,
  surfacing: "on_reference",
  enabled: true,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides,
});

const serviceWith = (repository: Partial<ContextVariableRepositoryPort>) => new ContextVariableService({
  repository: { listByAgent: async () => [], classifiedEnablementAgentIds: async () => [], ...repository } as ContextVariableRepositoryPort,
  agentReader: { get: async () => ({ id: agentId }) },
  agentSkillsReader: { list: async () => [] },
});

const classifiedRequest = { workspaceId, agentId, variableId, source: "classified" as const, surfacing: "on_reference" as const };

describe("the classified source", () => {
  it("is a source whose value both resolve paths read from the store, like pushed", () => {
    expect(CONTEXT_VARIABLE_SOURCES).toContain("classified");
    expect(readsStoredValue("classified")).toBe(true);
    expect(readsStoredValue("pushed")).toBe(true);
    expect(readsStoredValue("resolver")).toBe(false);
  });

  it("fits only a Choice attribute that is neither private nor treated as proof", () => {
    expect(classificationRefusal(choice())).toBeNull();
    expect(classificationRefusal(choice({ valueType: "string", options: null }))).toBe("not_choice");
    expect(classificationRefusal(choice({ sensitivity: "sensitive" }))).toBe("private");
    expect(classificationRefusal(choice({ trustTier: "signed" }))).toBe("proof");
  });

  it("lets an agent classify a Choice attribute", async () => {
    const upsertEnablement = vi.fn(async () => enablement(variableId));
    const service = serviceWith({ get: async () => choice(), upsertEnablement });

    await service.upsertEnablement(classifiedRequest);

    expect(upsertEnablement).toHaveBeenCalledWith(expect.objectContaining({ source: "classified", variableId }));
  });

  it.each([
    ["a Text attribute", { valueType: "string" as const, options: null }, /Choice \(enum\)/u],
    ["a Private attribute", { sensitivity: "sensitive" as const }, /Private \(sensitive\)/u],
    ["an attribute treated as proof", { trustTier: "signed" as const }, /proof \(signed\)/u],
  ])("refuses to classify %s, saying why", async (_label, overrides, reason) => {
    const upsertEnablement = vi.fn();
    const service = serviceWith({ get: async () => choice(overrides), upsertEnablement });

    await expect(service.upsertEnablement(classifiedRequest)).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(reason) });
    expect(upsertEnablement).not.toHaveBeenCalled();
  });

  it(`refuses a classified attribute past ${CONTEXT_VARIABLES_BEHAVIOR.maxClassifiedPerAgent} on one agent, counting only other enabled ones`, async () => {
    const limit = CONTEXT_VARIABLES_BEHAVIOR.maxClassifiedPerAgent;
    const others = Array.from({ length: limit }, (_, index) => enablement(`00000000-0000-4000-8000-1000000000${String(index).padStart(2, "0")}`));
    const upsertEnablement = vi.fn(async () => enablement(variableId));

    const full = serviceWith({ get: async () => choice(), listByAgent: async () => others, upsertEnablement });
    await expect(full.upsertEnablement(classifiedRequest)).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/at most 8/u) });

    const withSelfAndDisabled = serviceWith({
      get: async () => choice(),
      listByAgent: async () => [...others.slice(1), enablement(variableId), enablement("00000000-0000-4000-8000-200000000000", { enabled: false })],
      upsertEnablement,
    });
    await withSelfAndDisabled.upsertEnablement(classifiedRequest);
    expect(upsertEnablement).toHaveBeenCalledTimes(1);
  });

  it("checks a proposal's classified enablement against the definition it proposes", async () => {
    const applyProposal = vi.fn(async () => ({ variableId }));
    const service = serviceWith({ applyProposal });
    const write = { name: "topic", description: null, valueType: "enum" as const, options: [option("billing")], trustTier: "unverified" as const, defaultSurfacing: "on_reference" as const };
    const proposal = (sensitivity: "normal" | "sensitive") => ({
      workspaceId, agentId, variableId: null,
      definition: { ...write, sensitivity },
      expectedVariableUpdatedAt: null,
      enablement: { source: "classified" as const, resolverSkillId: null, maxAgeSeconds: null, resolverTimeoutMs: null, surfacing: "on_reference" as const, enabled: true },
      expectedEnablementUpdatedAt: null,
    });

    await service.applyProposal(proposal("normal"));
    await expect(service.applyProposal(proposal("sensitive"))).rejects.toMatchObject({ statusCode: 400 });
    expect(applyProposal).toHaveBeenCalledTimes(1);
  });

  it("refuses to make an attribute an agent classifies private, proof or not a Choice", async () => {
    const update = vi.fn(async () => choice());
    const service = serviceWith({ get: async () => choice(), update, classifiedEnablementAgentIds: async () => [agentId] });

    await expect(service.update(workspaceId, variableId, { sensitivity: "sensitive" })).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/classified/u) });
    await expect(service.update(workspaceId, variableId, { trustTier: "signed" })).rejects.toMatchObject({ statusCode: 400 });
    await service.update(workspaceId, variableId, { description: "What the visitor asks about" });
    expect(update).toHaveBeenCalledTimes(1);

    const unused = serviceWith({ get: async () => choice(), update, classifiedEnablementAgentIds: async () => [] });
    await unused.update(workspaceId, variableId, { sensitivity: "sensitive" });
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("lets a proposal make an attribute private when it also stops its own agent classifying it", async () => {
    const applyProposal = vi.fn(async () => ({ variableId }));
    const service = serviceWith({ get: async () => choice(), applyProposal, classifiedEnablementAgentIds: async () => [agentId] });
    const definition = { name: "topic", description: null, valueType: "enum" as const, options: [option("billing"), option("shipping")], trustTier: "unverified" as const, sensitivity: "sensitive" as const, defaultSurfacing: "on_reference" as const };
    const pushed = { source: "pushed" as const, resolverSkillId: null, maxAgeSeconds: null, resolverTimeoutMs: null, surfacing: "on_reference" as const, enabled: true };

    await service.applyProposal({ workspaceId, agentId, variableId, definition, expectedVariableUpdatedAt: null, enablement: pushed, expectedEnablementUpdatedAt: null });
    expect(applyProposal).toHaveBeenCalledTimes(1);
    await expect(service.applyProposal({ workspaceId, agentId, variableId, definition, expectedVariableUpdatedAt: null, enablement: null, expectedEnablementUpdatedAt: null }))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});
