import { describe, expect, it, vi } from "vitest";

import { AgentService, type AgentSettingsResource } from "../../src/modules/agents/public.js";

describe("AgentService read-only discovery", () => {
  it("returns an empty list without creating or assigning a default agent", async () => {
    const agentRepository = {
      listByWorkspaceId: vi.fn(async () => []),
      create: vi.fn(),
      setDefault: vi.fn(),
    };
    const workspaceRepository = {
      findById: vi.fn(async () => ({ id: "workspace-1", defaultAgentId: null })),
      updateGeneralSettings: vi.fn(),
    };
    const service = new AgentService(agentRepository as never, workspaceRepository as never) as AgentService & {
      listExisting(workspaceId: string): Promise<AgentSettingsResource[]>;
    };

    await expect(service.listExisting("workspace-1")).resolves.toEqual([]);
    expect(agentRepository.listByWorkspaceId).toHaveBeenCalledWith("workspace-1");
    expect(agentRepository.create).not.toHaveBeenCalled();
    expect(agentRepository.setDefault).not.toHaveBeenCalled();
    expect(workspaceRepository.updateGeneralSettings).not.toHaveBeenCalled();
  });
});
