import { describe, expect, it, vi } from "vitest";

import { ContextVariableService } from "../../src/modules/context-variables/services/contextVariableService.js";
import type {
  ContextVariable,
  ContextVariableOption,
  ContextVariableValue,
} from "../../src/modules/context-variables/domain.js";
import type { ContextVariableRepositoryPort } from "../../src/modules/context-variables/repository.js";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const variableId = "00000000-0000-4000-8000-000000000002";
const agentId = "00000000-0000-4000-8000-000000000003";
const conversationId = "00000000-0000-4000-8000-000000000004";

const option = (key: string, archived = false): ContextVariableOption => ({ key, label: key, description: null, archived });

const variable = (overrides: Partial<ContextVariable> = {}): ContextVariable => ({
  id: variableId,
  workspaceId,
  name: "topic",
  description: null,
  valueType: "enum",
  options: [option("billing"), option("shipping"), option("legacy", true)],
  trustTier: "unverified",
  sensitivity: "normal",
  defaultSurfacing: "on_reference",
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides,
});

const storedValue = (data: unknown): ContextVariableValue => ({
  id: "value-1",
  workspaceId,
  variableId,
  scope: { type: "conversation", id: conversationId },
  data,
  lastModified: new Date(0),
  writtenBy: { kind: "api", ref: "credential-1" },
});

const serviceWith = (repository: Partial<ContextVariableRepositoryPort>) => new ContextVariableService({
  repository: repository as ContextVariableRepositoryPort,
  agentReader: { get: async () => ({ id: agentId }) },
  agentSkillsReader: { list: async () => [] },
});

const definition = {
  workspaceId,
  name: "topic",
  trustTier: "unverified" as const,
  sensitivity: "normal" as const,
  defaultSurfacing: "on_reference" as const,
};

describe("ContextVariableService typed definitions", () => {
  it("creates an enum with its options and refuses one without", async () => {
    const create = vi.fn(async () => variable());
    const service = serviceWith({ create });

    await service.create({ ...definition, valueType: "enum", options: [option("billing")] });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ valueType: "enum", options: [option("billing")] }));

    await expect(service.create({ ...definition, valueType: "enum" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.create({ ...definition, valueType: "string", options: [option("billing")] }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("refuses an edit that drops an option, and keeps the stored options when the edit names none", async () => {
    const update = vi.fn(async () => variable());
    const service = serviceWith({ get: async () => variable(), update, hasValues: async () => true });

    await expect(service.update(workspaceId, variableId, { options: [option("billing")] }))
      .rejects.toMatchObject({ statusCode: 400 });

    await service.update(workspaceId, variableId, {
      options: [option("billing"), option("shipping", true), option("legacy", true), option("returns")],
    });
    expect(update).toHaveBeenLastCalledWith(workspaceId, variableId, expect.objectContaining({
      valueType: "enum",
      options: [option("billing"), option("shipping", true), option("legacy", true), option("returns")],
    }));

    await service.update(workspaceId, variableId, { description: "What the conversation is about." });
    expect(update).toHaveBeenLastCalledWith(workspaceId, variableId, { description: "What the conversation is about." });
  });

  it("refuses to change the type of a variable that has values", async () => {
    const update = vi.fn(async () => variable({ valueType: "string", options: null }));
    const withValues = serviceWith({ get: async () => variable(), update, hasValues: async () => true });
    await expect(withValues.update(workspaceId, variableId, { valueType: "string" })).rejects.toMatchObject({ statusCode: 409 });
    expect(update).not.toHaveBeenCalled();

    const empty = serviceWith({ get: async () => variable(), update, hasValues: async () => false });
    await empty.update(workspaceId, variableId, { valueType: "string" });
    expect(update).toHaveBeenCalledWith(workspaceId, variableId, { valueType: "string", options: null });
  });

  it("checks a proposal's definition the same way", async () => {
    const applyProposal = vi.fn(async () => ({ variableId }));
    const service = serviceWith({ get: async () => variable(), applyProposal, hasValues: async () => true });
    const write = {
      name: "topic",
      description: null,
      trustTier: "unverified" as const,
      sensitivity: "normal" as const,
      defaultSurfacing: "on_reference" as const,
    };
    const proposal = { workspaceId, agentId, expectedVariableUpdatedAt: new Date(0), enablement: null, expectedEnablementUpdatedAt: null };

    await expect(service.applyProposal({ ...proposal, variableId, definition: { ...write, valueType: "enum", options: [option("billing")] } }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(service.applyProposal({ ...proposal, variableId, definition: { ...write, valueType: "json", options: null } }))
      .rejects.toMatchObject({ statusCode: 409 });
    await expect(service.applyProposal({ ...proposal, variableId: null, definition: { ...write, valueType: "enum", options: null } }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(applyProposal).not.toHaveBeenCalled();
  });
});

describe("ContextVariableService value writes", () => {
  it("writes an active option key with the writer it is given", async () => {
    const upsertValue = vi.fn(async () => storedValue("billing"));
    const service = serviceWith({ get: async () => variable(), upsertValue });
    const scope = { type: "conversation" as const, id: conversationId };
    const writtenBy = { kind: "api" as const, ref: "credential-1" };

    await expect(service.upsertValue(workspaceId, variableId, scope, "billing", writtenBy)).resolves.toEqual(storedValue("billing"));
    expect(upsertValue).toHaveBeenCalledWith(variableId, scope, "billing", writtenBy);

    await expect(service.upsertValue(workspaceId, variableId, scope, "legacy", writtenBy)).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.upsertValue(workspaceId, variableId, scope, "Billing", writtenBy)).rejects.toMatchObject({ statusCode: 400 });
    expect(upsertValue).toHaveBeenCalledTimes(1);
  });
});
