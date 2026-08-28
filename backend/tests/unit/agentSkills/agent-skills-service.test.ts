import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
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
        settingsFields: [],
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

  it("creates notify skills without binding a connection target", async () => {
    const { service } = makeService();
    const workspaceId = randomUUID();
    const agentId = randomUUID();

    const created = await service.create(workspaceId, agentId, {
      name: "contact_human",
      capability: "notify",
      target: { kind: "notify_delivery", id: null },
      config: {
        delivery: {
          recipientEmails: ["sales@example.com"],
          webhook: { url: "https://hooks.example.com/contact" },
        },
        exposedInputs: { message: true, email: true },
      },
      invocationMode: "routine_named",
      enabled: true,
    });

    expect(created).toMatchObject({
      name: "contact_human",
      capability: "notify",
      storedKind: "notify",
      target: { kind: "notify_delivery", id: null },
      invocationMode: "routine_named",
      enabled: true,
    });
  });

  it("replaces skill config when a full form save clears prior overrides", async () => {
    const { service } = makeService();
    const workspaceId = randomUUID();
    const agentId = randomUUID();

    const created = await service.create(workspaceId, agentId, {
      name: "answer",
      capability: "retrieve",
      target: { kind: "source_scope", id: null },
      config: {
        sourceScope: "all",
        exposedInputs: { query: true },
        rerankEnabled: false,
        vectorTopK: 12,
      },
      invocationMode: "default_answer",
      enabled: true,
    });

    const updated = await service.update(workspaceId, agentId, created.id, {
      replaceConfig: {
        sourceScope: "all",
        exposedInputs: { query: true },
      },
    });

    expect(updated.config).toEqual({
      sourceScope: "all",
      exposedInputs: { query: true },
    });
  });

  it("deep-merges a partial config patch so an untouched sibling field survives", async () => {
    // A notify skill's `delivery` carries both a webhook URL and recipient emails. A PATCH that
    // only supplies `delivery.recipientEmails` must not disturb `delivery.webhook` - a shallow
    // top-level merge would replace the whole `delivery` object and, via notifyDeliverySchema's
    // `.default(null)` on `webhook`, silently reset the stored webhook URL to null.
    const { service } = makeService();
    const workspaceId = randomUUID();
    const agentId = randomUUID();

    const created = await service.create(workspaceId, agentId, {
      name: "contact_human",
      capability: "notify",
      target: { kind: "notify_delivery", id: null },
      config: {
        delivery: {
          recipientEmails: ["sales@example.com"],
          webhook: { url: "https://hooks.example.com/contact" },
        },
        exposedInputs: { message: true, email: true },
      },
      invocationMode: "routine_named",
      enabled: true,
    });

    const updated = await service.update(workspaceId, agentId, created.id, {
      config: {
        delivery: { recipientEmails: ["sales@example.com", "ops@example.com"] },
      },
    });

    expect(updated.config).toEqual({
      delivery: {
        recipientEmails: ["sales@example.com", "ops@example.com"],
        webhook: { url: "https://hooks.example.com/contact" },
      },
      exposedInputs: { message: true, email: true },
    });
  });

  it("raises a conflict and leaves a concurrent edit intact when expectedUpdatedAt no longer matches", async () => {
    const { service } = makeService();
    const workspaceId = randomUUID();
    const agentId = randomUUID();

    const created = await service.create(workspaceId, agentId, {
      name: "answer",
      capability: "retrieve",
      target: { kind: "source_scope", id: null },
      config: { sourceScope: "all", exposedInputs: { query: true } },
      invocationMode: "default_answer",
      enabled: true,
    });

    // Simulates a concurrent edit landing after a caller read created.updatedAt as its version
    // token but before it called update. The repository stamps updated_at from the wall clock,
    // so the clock must actually advance between the two writes for the timestamps to differ.
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(1_000);
      const concurrentEdit = await service.update(workspaceId, agentId, created.id, { enabled: false });
      expect(concurrentEdit.enabled).toBe(false);
      expect(concurrentEdit.updatedAt).not.toBe(created.updatedAt);
    } finally {
      vi.useRealTimers();
    }

    await expect(
      service.update(workspaceId, agentId, created.id, { enabled: true }, { expectedUpdatedAt: new Date(created.updatedAt) }),
    ).rejects.toMatchObject({ statusCode: 409, code: "conflict" });

    // The concurrent edit must survive the stale update attempt.
    const persisted = (await service.list(workspaceId, agentId)).find((skill) => skill.id === created.id);
    expect(persisted?.enabled).toBe(false);
  });

  it("updates when expectedUpdatedAt matches the skill's current version", async () => {
    const { service } = makeService();
    const workspaceId = randomUUID();
    const agentId = randomUUID();

    const created = await service.create(workspaceId, agentId, {
      name: "answer",
      capability: "retrieve",
      target: { kind: "source_scope", id: null },
      config: { sourceScope: "all", exposedInputs: { query: true } },
      invocationMode: "default_answer",
      enabled: true,
    });

    const updated = await service.update(workspaceId, agentId, created.id, { enabled: false }, {
      expectedUpdatedAt: new Date(created.updatedAt),
    });
    expect(updated.enabled).toBe(false);
  });

  describe("persistence-error translation", () => {
    const makeServiceThatThrowsOnCreate = (error: unknown) => {
      const repository = {
        ...new InMemoryAgentSkillRepository(),
        findByName: async () => null,
        findDefaultAnswer: async () => null,
        create: async () => {
          throw error;
        },
      } as unknown as InMemoryAgentSkillRepository;
      return new AgentSkillsService({
        repository,
        capabilities: createDefaultSkillCapabilityRegistry(),
      });
    };

    const webhookInput = {
      name: "send_webhook",
      capability: "webhook_call" as const,
      target: { kind: "webhook_destination", id: randomUUID() },
      config: { boundPayload: {}, exposedPayload: {} },
      invocationMode: "routine_named" as const,
      enabled: true,
    };

    it("maps an unknown/foreign target reference (23503) to a 400, not a 500", async () => {
      const service = makeServiceThatThrowsOnCreate({
        code: "23503",
        constraint: "agent_skills_webhook_target_fk",
      });
      await expect(service.create(randomUUID(), randomUUID(), webhookInput)).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it("disambiguates a default-answer collision from a name collision on 23505", async () => {
      const defaultAnswerConflict = makeServiceThatThrowsOnCreate({
        code: "23505",
        constraint: "agent_skills_one_default_answer",
      });
      await expect(defaultAnswerConflict.create(randomUUID(), randomUUID(), webhookInput)).rejects.toMatchObject({
        statusCode: 409,
        message: "A default-answer skill already exists for this agent",
      });

      const nameConflict = makeServiceThatThrowsOnCreate({
        code: "23505",
        constraint: "agent_skills_agent_id_skill_name_key",
      });
      await expect(nameConflict.create(randomUUID(), randomUUID(), webhookInput)).rejects.toMatchObject({
        statusCode: 409,
        message: 'A skill named "send_webhook" already exists for this agent',
      });
    });
  });
});
