import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { AgentSkillsService } from "../../src/modules/agentSkills/service.js";
import { createDefaultSkillCapabilityRegistry } from "../../src/modules/skills/capabilityRegistry.js";
import { AgentService } from "../../src/modules/agents/public.js";
import { InMemoryAgentRepository, InMemoryWorkspaceRepository } from "../support/fakes.js";
import { InMemoryAgentSkillRepository } from "../support/inMemoryAgentSkills.js";

const requester = () => ({ requestConfirmations: vi.fn(async () => undefined) });

describe("recipient confirmation requests on save", () => {
  it("asks only the addresses an agent contact-settings change adds", async () => {
    const workspaceRepository = new InMemoryWorkspaceRepository();
    const workspace = await workspaceRepository.create("account-1", "Workspace");
    const confirmations = requester();
    const service = new AgentService(
      new InMemoryAgentRepository(),
      workspaceRepository,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      confirmations,
    );
    const agent = await service.resolve(workspace.id);

    await service.update(workspace.id, agent.id, {
      contactRequestDelivery: { recipientEmails: ["reception@example.com"], webhook: null },
    });
    await service.update(workspace.id, agent.id, {
      contactRequestDelivery: { recipientEmails: ["Reception@example.com", "manager@example.com"], webhook: null },
    });

    expect(confirmations.requestConfirmations.mock.calls.map(([call]) => [call.agentId, call.emails])).toEqual([
      [agent.id, ["reception@example.com"]],
      [agent.id, ["manager@example.com"]],
    ]);
  });

  it("asks only the addresses a notify-skill change adds, and none on removal", async () => {
    const confirmations = requester();
    const service = new AgentSkillsService({
      repository: new InMemoryAgentSkillRepository(),
      capabilities: createDefaultSkillCapabilityRegistry(),
      recipientConfirmations: confirmations,
    });
    const workspaceId = randomUUID();
    const agentId = randomUUID();
    const created = await service.create(workspaceId, agentId, {
      name: "notify_ops",
      capability: "notify",
      target: { kind: "notify_delivery", id: null },
      config: { delivery: { recipientEmails: ["ops@example.com"], webhook: null } },
      invocationMode: "routine_named",
      enabled: true,
    });
    await service.update(workspaceId, agentId, created.id, {
      config: { delivery: { recipientEmails: ["ops@example.com", "desk@example.com"], webhook: null } },
    });
    await service.remove(workspaceId, agentId, created.id);

    expect(confirmations.requestConfirmations.mock.calls.map(([call]) => call.emails)).toEqual([
      ["ops@example.com"],
      ["desk@example.com"],
    ]);
    expect(confirmations.requestConfirmations).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, agentId }));
  });
});
