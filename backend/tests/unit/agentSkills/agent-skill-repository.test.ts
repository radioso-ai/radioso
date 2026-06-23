import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { InMemoryAgentSkillRepository } from "../../support/inMemoryAgentSkills.js";

describe("AgentSkillRepository facade", () => {
  it("round-trips any stored kind while preserving target and config shape", async () => {
    const repository = new InMemoryAgentSkillRepository();
    const workspaceId = randomUUID();
    const agentId = randomUUID();

    const created = await repository.create({
      workspaceId,
      agentId,
      skillName: "send_lead",
      kind: "webhook",
      targetType: "webhook_destination",
      targetId: randomUUID(),
      config: {
        boundPayload: { source: "routine" },
        exposedPayload: { email: { slotBinding: "customerEmail" } },
      },
      invocationMode: "routine_named",
      enabled: true,
    });

    expect(created).toMatchObject({
      id: expect.any(String),
      workspaceId,
      agentId,
      skillName: "send_lead",
      kind: "webhook",
      targetType: "webhook_destination",
      config: {
        boundPayload: { source: "routine" },
        exposedPayload: { email: { slotBinding: "customerEmail" } },
      },
      invocationMode: "routine_named",
      enabled: true,
    });

    await expect(repository.listByAgent(workspaceId, agentId)).resolves.toEqual([created]);
  });

  it("updates neutral fields and merges config without capability branching", async () => {
    const repository = new InMemoryAgentSkillRepository();
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    const skill = await repository.create({
      workspaceId,
      agentId,
      skillName: "post_slack",
      kind: "slack",
      targetType: "slack_installation",
      targetId: randomUUID(),
      config: { boundInputs: { channelId: "C123" }, exposedInputs: { text: {} } },
      invocationMode: "routine_named",
      enabled: true,
    });

    const updated = await repository.update(workspaceId, agentId, skill.id, {
      config: { exposedInputs: { text: { required: true } } },
      invocationMode: "agent_selectable",
      enabled: false,
    });

    expect(updated).toMatchObject({
      id: skill.id,
      enabled: false,
      invocationMode: "agent_selectable",
      config: {
        boundInputs: { channelId: "C123" },
        exposedInputs: { text: { required: true } },
      },
    });
  });
});
