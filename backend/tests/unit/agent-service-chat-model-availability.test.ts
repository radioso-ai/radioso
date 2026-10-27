import { describe, expect, it, vi } from "vitest";

import { AgentService } from "../../src/modules/agents/public.js";
import type { WorkspaceModelAvailability } from "../../src/shared/domain/workspaceModelAvailability.js";
import type { LlmProviderName } from "../../src/shared/infra/llm/providerTypes.js";
import { InMemoryAgentRepository, InMemoryWorkspaceRepository } from "../support/fakes.js";

// The live-EU shape: the platform openai key is an Azure key with one chat deployment, and the
// workspace holds no openai key of its own.
const azureOnly: WorkspaceModelAvailability = {
  runnableModels: vi.fn(async (_workspaceId: string, provider: LlmProviderName) =>
    provider === "openai" ? ["gpt-5.4-mini"] : null),
};

const setup = async () => {
  const workspaceRepository = new InMemoryWorkspaceRepository();
  const workspace = await workspaceRepository.create("account-1", "Workspace");
  const agentRepository = new InMemoryAgentRepository();
  const service = new AgentService(
    agentRepository,
    workspaceRepository,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    azureOnly,
  );
  const agent = await service.ensureDefaultAgent(workspace.id);
  return { service, agentRepository, workspaceId: workspace.id, agentId: agent.id };
};

const undeployed = { provider: "openai" as const, model: "gpt-5.4-nano" };

describe("AgentService chat model override availability", () => {
  it("rejects an override the workspace cannot run, naming the runnable models", async () => {
    const { service, workspaceId, agentId } = await setup();

    const attempt = service.update(workspaceId, agentId, { chatModelOverride: undeployed });

    await expect(attempt).rejects.toMatchObject({ statusCode: 400 });
    await expect(attempt).rejects.toThrow(/gpt-5\.4-nano[\s\S]*gpt-5\.4-mini/);
    expect((await service.get(workspaceId, agentId)).chatModelOverride).toBeNull();
  });

  it("rejects an unrunnable override on create", async () => {
    const { service, workspaceId } = await setup();

    await expect(service.create(workspaceId, { name: "Second", chatModelOverride: undeployed })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("accepts a runnable override, another provider's override, and clearing the override", async () => {
    const { service, workspaceId, agentId } = await setup();

    await service.update(workspaceId, agentId, { chatModelOverride: { provider: "openai", model: "gpt-5.4-mini" } });
    await service.update(workspaceId, agentId, { chatModelOverride: { provider: "claude", model: "claude-sonnet-4-5" } });
    const cleared = await service.update(workspaceId, agentId, { chatModelOverride: null });

    expect(cleared.chatModelOverride).toBeNull();
  });

  it("keeps saving an agent whose stored override stopped being runnable, as long as the override is unchanged", async () => {
    const { service, agentRepository, workspaceId, agentId } = await setup();
    await agentRepository.update(agentId, workspaceId, { chatModelOverride: undeployed });

    const renamed = await service.update(workspaceId, agentId, { name: "Renamed", chatModelOverride: undeployed });

    expect(renamed).toMatchObject({ name: "Renamed", chatModelOverride: undeployed });
  });

  it("rejects the same pick when Ray proposes it as an agent setting", async () => {
    const { service, workspaceId, agentId } = await setup();

    await expect(
      service.prepareFieldProposal(workspaceId, agentId, { settingKey: "chatModelOverride", value: undeployed }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("rejects an unrunnable override when a prepared proposal is applied", async () => {
    const { service, workspaceId, agentId } = await setup();

    await expect(
      service.applyFieldProposal(workspaceId, {
        targetAgentId: agentId,
        normalizedPatch: { chatModelOverride: undeployed },
        expected: { key: "chatModelOverride", value: null },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect((await service.get(workspaceId, agentId)).chatModelOverride).toBeNull();
  });
});
