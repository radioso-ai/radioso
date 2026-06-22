import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AgentSkillsService } from "../../../src/modules/agentSkills/service.js";
import {
  createDefaultSkillCapabilityRegistry,
  createSkillCapabilityDescriptor,
  SkillCapabilityRegistry,
} from "../../../src/modules/skills/capabilityRegistry.js";
import { InMemoryAgentSkillRepository } from "../../support/inMemoryAgentSkills.js";

const makeService = () => {
  const repository = new InMemoryAgentSkillRepository();
  const service = new AgentSkillsService({
    repository,
    capabilities: createDefaultSkillCapabilityRegistry(),
  });
  return { repository, service };
};

describe("AgentSkillsService", () => {
  it("creates and lists skills through a capability-neutral envelope", async () => {
    const { service } = makeService();
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    const targetId = randomUUID();

    const created = await service.create(workspaceId, agentId, {
      name: "send_email",
      capability: "email",
      target: { kind: "customer_email_connection", id: targetId },
      config: {
        mode: "draft",
        boundInputs: { to: "lead@example.com", subject: "Hello", bodyText: "Hi" },
        exposedInputs: {},
      },
      invocationMode: "routine_named",
      enabled: true,
    });

    expect(created).toMatchObject({
      name: "send_email",
      capability: "email",
      storedKind: "customer_email",
      target: { kind: "customer_email_connection", id: targetId },
      invocationMode: "routine_named",
      enabled: true,
    });

    await expect(service.list(workspaceId, agentId)).resolves.toEqual([created]);
  });

  it("rejects invalid routine identifiers and duplicate names", async () => {
    const { service } = makeService();
    const workspaceId = randomUUID();
    const agentId = randomUUID();

    await expect(service.create(workspaceId, agentId, {
      name: "bad-name",
      capability: "webhook_call",
      target: { kind: "webhook_destination", id: randomUUID() },
      config: { boundPayload: {}, exposedPayload: {} },
      invocationMode: "routine_named",
      enabled: true,
    })).rejects.toMatchObject({ statusCode: 400 });

    const input = {
      name: "send_webhook",
      capability: "webhook_call" as const,
      target: { kind: "webhook_destination", id: randomUUID() },
      config: { boundPayload: {}, exposedPayload: {} },
      invocationMode: "routine_named" as const,
      enabled: true,
    };

    await service.create(workspaceId, agentId, input);
    await expect(service.create(workspaceId, agentId, input)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects unsupported invocation modes and second default-answer skills", async () => {
    const { repository, service } = makeService();
    const workspaceId = randomUUID();
    const agentId = randomUUID();

    await expect(service.create(workspaceId, agentId, {
      name: "default_email",
      capability: "email",
      target: { kind: "customer_email_connection", id: randomUUID() },
      config: {
        mode: "draft",
        boundInputs: { to: "lead@example.com", subject: "Hello", bodyText: "Hi" },
        exposedInputs: {},
      },
      invocationMode: "default_answer",
      enabled: true,
    })).rejects.toMatchObject({ statusCode: 400 });

    const defaultAnswerRegistry = new SkillCapabilityRegistry([
      createSkillCapabilityDescriptor({
        id: "mcp_tool",
        storedKind: "external_mcp",
        targetKind: "mcp_connection",
        enumerateTargets: async () => [],
        inputSchema: { source: "discovered" },
        outcomeVocabulary: ["completed"],
        supportedInvocationModes: ["default_answer"],
        executorAdapter: "external-skills",
        configSchema: z.record(z.unknown()),
      }),
    ]);
    const serviceWithDefaultAnswerCapability = new AgentSkillsService({
      repository,
      capabilities: defaultAnswerRegistry,
    });

    await repository.create({
      workspaceId,
      agentId,
      skillName: "answer",
      kind: "external_mcp",
      targetType: "mcp_connection",
      targetId: null,
      config: {},
      invocationMode: "default_answer",
      enabled: true,
    });

    await expect(serviceWithDefaultAnswerCapability.create(workspaceId, agentId, {
      name: "answer_two",
      capability: "mcp_tool",
      target: { kind: "mcp_connection", id: null },
      config: {},
      invocationMode: "default_answer",
      enabled: true,
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("creates one default-answer retrieve skill and rejects a second with a friendly conflict", async () => {
    const { service } = makeService();
    const workspaceId = randomUUID();
    const agentId = randomUUID();

    await service.create(workspaceId, agentId, {
      name: "answer",
      capability: "retrieve",
      target: { kind: "source_scope", id: null },
      config: { sourceScope: "all", exposedInputs: { query: true } },
      invocationMode: "default_answer",
      enabled: true,
    });

    await expect(service.create(workspaceId, agentId, {
      name: "answer_two",
      capability: "retrieve",
      target: { kind: "source_scope", id: null },
      config: { sourceScope: "all", exposedInputs: { query: true } },
      invocationMode: "default_answer",
      enabled: true,
    })).rejects.toMatchObject({
      statusCode: 409,
      message: "A default-answer skill already exists for this agent",
    });
  });
});
