import { describe, expect, it, vi } from "vitest";

import { AgentService } from "../../src/modules/agents/public.js";
import { InMemoryAgentRepository, InMemoryWorkspaceRepository } from "../support/fakes.js";

const serviceWithWorkspace = async () => {
  const workspaceRepository = new InMemoryWorkspaceRepository();
  const agentRepository = new InMemoryAgentRepository();
  const workspace = await workspaceRepository.create("account-1", "Workspace");
  const service = new AgentService(agentRepository, workspaceRepository);
  const agent = await service.resolve(workspace.id);
  return { service, agentRepository, workspaceId: workspace.id, agentId: agent.id };
};

describe("agent service: what other modules follow of an agent", () => {
  it("tells its listener when a write changes the agent's default locale, and not otherwise", async () => {
    const { service, workspaceId, agentId } = await serviceWithWorkspace();
    const listener = vi.fn(async () => undefined);
    service.onDefaultLocaleChange(listener);

    await service.update(workspaceId, agentId, { name: "Front desk" });
    await service.update(workspaceId, agentId, { assistantDefaultLocale: "it" });
    await service.update(workspaceId, agentId, { assistantDefaultLocale: "it" });
    await service.update(workspaceId, agentId, { assistantDefaultLocale: null });

    expect(listener.mock.calls).toEqual([
      [{ workspaceId, agentId, defaultLocale: "it" }],
      [{ workspaceId, agentId, defaultLocale: null }],
    ]);
  });

  it("does not wait for the locale listener, and a listener that rejects never fails the write", async () => {
    const { service, workspaceId, agentId } = await serviceWithWorkspace();
    let release = () => {};
    service.onDefaultLocaleChange(() => new Promise<void>((_resolve, reject) => {
      release = () => reject(new Error("vendor down"));
    }));

    const updated = await service.update(workspaceId, agentId, { assistantDefaultLocale: "de" });
    release();

    expect(updated.assistantDefaultLocale).toBe("de");
  });

  it("asks its listener before an agent is deleted, once the deletion is allowed", async () => {
    const { service, agentRepository, workspaceId } = await serviceWithWorkspace();
    const second = await service.create(workspaceId, { name: "Second" });
    const seen: Array<{ workspaceId: string; agentId: string; stillStored: boolean }> = [];
    service.onBeforeDelete(async (agent) => {
      seen.push({ ...agent, stillStored: (await agentRepository.findByIdAndWorkspaceId(agent.agentId, agent.workspaceId)) !== null });
    });

    await service.delete(workspaceId, second.id);

    expect(seen).toEqual([{ workspaceId, agentId: second.id, stillStored: true }]);
  });

  it("does not ask before refusing to delete the last agent", async () => {
    const { service, workspaceId, agentId } = await serviceWithWorkspace();
    const listener = vi.fn(async () => undefined);
    service.onBeforeDelete(listener);

    await expect(service.delete(workspaceId, agentId)).rejects.toThrow("Cannot delete the last agent");
    expect(listener).not.toHaveBeenCalled();
  });

  it("deletes the agent even when its listener rejects", async () => {
    const { service, agentRepository, workspaceId } = await serviceWithWorkspace();
    const second = await service.create(workspaceId, { name: "Second" });
    service.onBeforeDelete(async () => {
      throw new Error("vendor down");
    });

    await service.delete(workspaceId, second.id);

    expect(await agentRepository.findByIdAndWorkspaceId(second.id, workspaceId)).toBeNull();
  });
});
